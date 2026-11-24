// Scout Chat's local server: the page, a JSON API over Scout's runtime, and a live stream.
//
// It listens on 127.0.0.1 only. A post goes out in your name, so the server accepts one only from
// its own page: the Host must be this server and the Origin must match it. A page on another site,
// or a DNS name pointed at 127.0.0.1, can't post through it.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as rt from "./runtime.mjs";
import { integrations as defaultIntegrations } from "./integrations.mjs";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

/** Hosts this server answers to on its port. */
export function sameHost(host, port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`].includes(String(host || "").toLowerCase());
}
/** A write is allowed only from this server's own page. */
export function allowedWrite(headers, port) {
  return sameHost(headers.host, port) && headers.origin === `http://${headers.host.toLowerCase()}`;
}

const jsonWrite = (headers, port) => allowedWrite(headers, port) && /^application\/json(?:\s*;|$)/i.test(headers["content-type"] || "");

export function createServer({ port, key, keyProblem, integrations = defaultIntegrations }) {
  const streams = new Set();
  const stopFollowing = rt.follow((conversationId) => {
    const line = `event: message\ndata: ${JSON.stringify({ conversationId })}\n\n`;
    for (const res of streams) res.write(line);
  });

  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on("data", (c) => { n += c.length; if (n > 64e3) { reject(new Error("too large")); req.destroy(); } else parts.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}")); } catch { reject(new Error("not JSON")); } });
    req.on("error", reject);
  });

  const server = http.createServer(async (req, res) => {
    const localPort = port || server.address()?.port;
    if (!sameHost(req.headers.host, localPort)) { res.writeHead(421); return res.end(); }
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    try {
      if (p === "/api/status") {
        const up = await rt.up();
        const node = up ? await rt.nodeInfo() : null;
        return json(res, 200, { runtime: up ? rt.runtimeUrl() : null, host: node?.name || null, canPost: Boolean(key), why: key ? null : keyProblem });
      }
      if (p === "/api/integrations" && req.method === "GET") return json(res, 200, await integrations.status());
      const connect = p.match(/^\/api\/integrations\/(board|slack)$/);
      if (connect && req.method === "POST") {
        if (!jsonWrite(req.headers, localPort)) return json(res, 403, { error: "posts come from this page only" });
        let body;
        try { body = await readBody(req); }
        catch { return json(res, 400, { error: "Send the connection details as JSON." }); }
        try { return json(res, 200, await integrations.connect(connect[1], body)); }
        catch (e) {
          const known = [400, 409, 502].includes(e.status);
          return json(res, known ? e.status : 502, { error: known ? e.message : "Scout couldn't finish the request." });
        }
      }
      if (p === "/api/rooms") return json(res, 200, { rooms: await rt.rooms() });
      const m = p.match(/^\/api\/rooms\/([^/]+)\/messages$/);
      let roomId;
      if (m) {
        try { roomId = decodeURIComponent(m[1]); } catch { return json(res, 400, { error: "Invalid room address." }); }
      }
      if (m && req.method === "GET") {
        const room = (await rt.rooms()).find((r) => r.id === roomId);
        return json(res, 200, { messages: await rt.messages(roomId, {
          agentName: room?.kind === "direct" ? room.agentName : null,
          messageId: url.searchParams.get("message"),
        }) });
      }
      if (m && req.method === "POST") {
        if (!jsonWrite(req.headers, localPort)) return json(res, 403, { error: "posts come from this page only" });
        if (!key) return json(res, 409, { error: keyProblem || "posting isn't set up" });
        const { body } = await readBody(req);
        const text = typeof body === "string" ? body.trim() : "";
        if (!text) return json(res, 400, { error: "write something first" });
        const room = (await rt.rooms()).find((r) => r.id === roomId);
        if (!room) return json(res, 404, { error: "that room isn't on this host" });
        return json(res, 200, await rt.post({ room, body: text }, key));
      }
      if (p === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": open\n\n");
        streams.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25e3);
        req.on("close", () => { clearInterval(ping); streams.delete(res); });
        return;
      }
      if (p.startsWith("/api/")) return json(res, 404, { error: "no such route" });
      // the page
      const file = path.join(PUBLIC, p === "/" ? "index.html" : path.normalize(p).replace(/^([/\\])+/, ""));
      if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404); return res.end("Not found");
      }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      const down = /fetch failed|ECONNREFUSED|timeout/i.test(String(e?.cause?.code || e?.message || e));
      json(res, down ? 503 : 502, { error: down ? "Scout's runtime isn't answering on this host" : String(e?.message || e) });
    }
  });
  server.on("close", () => { stopFollowing(); for (const s of streams) s.end(); });
  return server;
}
