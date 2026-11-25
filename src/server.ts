import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkRuntime,
  createScoutThinHttpHandler,
  runtimeUrl,
  scanLocalFeedSessions,
  sendJson,
} from "scout-app/thin-server";
// @ts-expect-error plain ESM server module
import { hello } from "../server/local.mjs";
// @ts-expect-error plain ESM server module
import * as rt from "../server/runtime.mjs";
// @ts-expect-error plain ESM server module
import { integrations as defaultIntegrations } from "../server/integrations.mjs";

export const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

const THIN_SHARED_PATHS = new Set([
  "/api/host-status",
  "/api/setup",
  "/api/recent-sessions",
  "/api/session-context",
  "/api/messages",
  "/v1/events/stream",
  "/v1/tail/events",
]);

function isThinSharedRoute(pathname: string): boolean {
  return THIN_SHARED_PATHS.has(pathname) || pathname.startsWith("/api/session-ref/");
}

/** Hosts this server answers to on its port. */
export function sameHost(host: string | undefined, port: number | undefined): boolean {
  return [`127.0.0.1:${port}`, `localhost:${port}`].includes(String(host || "").toLowerCase());
}

/** A write is allowed only from this server's own page. */
export function allowedWrite(headers: http.IncomingHttpHeaders, port: number | undefined): boolean {
  const host = String(headers.host || "").toLowerCase();
  return sameHost(headers.host, port) && headers.origin === `http://${host}`;
}

const jsonWrite = (headers: http.IncomingHttpHeaders, port: number | undefined) =>
  allowedWrite(headers, port) && /^application\/json(?:\s*;|$)/i.test(String(headers["content-type"] || ""));

const handleThinRoutes = createScoutThinHttpHandler({
  packageName: "@openscout/chat",
  product: "Chat",
  apiHandler: async (req, res, { pathname }) => {
    if (req.method === "GET" && pathname === "/api/host-status") {
      const base = runtimeUrl();
      const runtimeUp = await checkRuntime(base);
      const localSessions = scanLocalFeedSessions({ maxPerHarness: 15, limit: 30 }).length;
      sendJson(res, 200, { runtimeUp, runtimeUrl: base, localSessions });
      return true;
    }
    return false;
  },
});

export function createServer({
  port,
  key,
  keyProblem,
  integrations = defaultIntegrations,
}: {
  port?: number;
  key?: string | null;
  keyProblem?: string | null;
  integrations?: typeof defaultIntegrations;
} = {}) {
  const streams = new Set<http.ServerResponse>();
  const operatorKey = () => (key === undefined && keyProblem === undefined ? rt.readKey() : { key, problem: keyProblem });
  let stopFollowing: (() => void) | undefined;
  let connection = "connecting";
  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const broadcast = (name: string, data: unknown) => {
    for (const res of streams) res.write(event(name, data));
  };
  const onConnection = (next: string) => {
    if (connection === next) return;
    connection = next;
    broadcast("connection", connection);
  };

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<unknown>((resolve, reject) => {
      let n = 0;
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        n += c.length;
        if (n > 64e3) {
          reject(new Error("too large"));
          req.destroy();
        } else {
          parts.push(c);
        }
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"));
        } catch {
          reject(new Error("not JSON"));
        }
      });
      req.on("error", reject);
    });

  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");

    const addr = server.address();
    const localPort = port || (typeof addr === "object" && addr ? addr.port : undefined);
    if (!sameHost(req.headers.host, localPort)) {
      res.writeHead(421);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const p = url.pathname;

    try {
      if (isThinSharedRoute(p)) {
        if (await handleThinRoutes(req, res)) return;
      }

      if (p === "/api/hello" && req.method === "GET") return json(res, 200, hello());
      if (p === "/api/status") return json(res, 200, await rt.readiness(operatorKey()));
      if (p === "/api/integrations" && req.method === "GET") return json(res, 200, await integrations.status());

      const connect = p.match(/^\/api\/integrations\/(board|slack)$/);
      if (connect && req.method === "POST") {
        if (!jsonWrite(req.headers, localPort)) return json(res, 403, { error: "posts come from this page only" });
        let body: unknown;
        try {
          body = await readBody(req);
        } catch {
          return json(res, 400, { error: "Send the connection details as JSON." });
        }
        try {
          return json(res, 200, await integrations.connect(connect[1], body));
        } catch (e: unknown) {
          const err = e as { status?: number; message?: string };
          const known = err.status === 400 || err.status === 409 || err.status === 502;
          return json(res, known ? err.status! : 502, {
            error: known ? err.message : "Scout couldn't finish the request.",
          });
        }
      }

      if (p === "/api/rooms") {
        const rooms = await rt.rooms();
        return json(res, 200, rooms.length ? { rooms } : { rooms, targets: await rt.askTargets().catch(() => null) });
      }

      const m = p.match(/^\/api\/rooms\/([^/]+)\/messages$/);
      let roomId: string | undefined;
      if (m) {
        try {
          roomId = decodeURIComponent(m[1]);
        } catch {
          return json(res, 400, { error: "Invalid room address." });
        }
      }

      if (m && req.method === "GET") {
        const room = (await rt.rooms()).find((r: { id: string }) => r.id === roomId);
        return json(res, 200, {
          knownRoom: !!room,
          messages: await rt.messages(roomId, {
            agentName: room?.kind === "direct" ? room.agentName : null,
            messageId: url.searchParams.get("message"),
          }),
        });
      }

      const firstAsk = p === "/api/ask";
      if ((m || firstAsk) && req.method === "POST") {
        if (!jsonWrite(req.headers, localPort)) return json(res, 403, { error: "posts come from this page only" });
        const { key: opKey, problem } = operatorKey();
        if (!opKey) return json(res, 409, { error: problem || "posting isn't set up" });
        let data: unknown;
        try {
          data = await readBody(req);
        } catch {
          // handled below
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          return json(res, 400, { error: "Send the message as JSON." });
        }
        const { body, requestId, targetAgentId } = data as {
          body?: unknown;
          requestId?: unknown;
          targetAgentId?: unknown;
        };
        if (requestId !== undefined && (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId))) {
          return json(res, 400, { error: "Invalid request ID." });
        }
        const text = typeof body === "string" ? body.trim() : "";
        if (!text) return json(res, 400, { error: "write something first" });

        if (firstAsk) {
          const target = (await rt.askTargets()).find((a: { id: string }) => a.id === targetAgentId);
          if (!target) return json(res, 409, { error: "That agent is no longer available." });
          return json(res, 200, await rt.post({ target, body: text, requestId }, opKey));
        }

        const room = (await rt.rooms()).find((r: { id: string }) => r.id === roomId);
        if (!room) return json(res, 404, { error: "that room isn't on this host" });
        if (targetAgentId !== undefined && targetAgentId !== (room.askTarget?.id ?? null)) {
          return json(res, 409, { error: "The room’s recipient changed. Check the room before sending." });
        }
        return json(
          res,
          200,
          await rt.post({ conversationId: room.id, target: room.askTarget, body: text, requestId }, opKey),
        );
      }

      if (p === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        res.write(event("connection", connection));
        streams.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25e3);
        req.on("close", () => {
          clearInterval(ping);
          streams.delete(res);
        });
        return;
      }

      if (p.startsWith("/api/")) return json(res, 404, { error: "no such route" });

      const rel = path.normalize(p).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
      let file = path.join(DIST, rel || "index.html");
      if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(DIST, "index.html");
      }
      if (!fs.existsSync(file)) {
        sendJson(res, 503, { error: "dist/index.html is missing. Run npm run build first." });
        return;
      }
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file)] || "application/octet-stream",
        "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=3600",
      });
      fs.createReadStream(file).pipe(res);
    } catch (e: unknown) {
      const err = e as { cause?: { code?: string }; message?: string };
      const down = /fetch failed|ECONNREFUSED|timeout/i.test(String(err?.cause?.code || err?.message || e));
      json(res, down ? 503 : 502, {
        error: down ? "Scout's runtime isn't answering on this host" : String(err?.message || e),
      });
    }
  });

  server.on("listening", () => {
    stopFollowing = rt.follow({
      onMessage: (conversationId: string) => broadcast("message", { conversationId }),
      onConnection,
      onTargets: () => broadcast("targets", null),
    });
  });

  server.on("close", () => {
    stopFollowing?.();
    for (const s of streams) s.end();
  });

  return server;
}

export function serve(port: number): Promise<http.Server> {
  const server = createServer({ port });
  return new Promise((resolve, reject) => {
    server.once("error", reject).listen(port, "127.0.0.1", () => resolve(server));
  });
}
