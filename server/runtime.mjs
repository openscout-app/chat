// Scout's runtime, as Chat uses it: rooms and messages to read, and a signed post as the operator.
//
// Reads need nothing. A post in your name carries the operator attribution that `scout setup`
// created: an owner-only key file under Scout's support folder. Chat reads it when needed and
// signs each post the way the runtime verifies them (local-admin:v1, HMAC-SHA256). The key never
// leaves this process and is never printed.
import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export function runtimeUrl() {
  const env = process.env.SCOUT_RUNTIME_URL || process.env.OPENSCOUT_BROKER_URL;
  if (env) return env.replace(/\/+$/, "");
  try {
    const home = process.env.OPENSCOUT_HOME || path.join(os.homedir(), ".openscout");
    const c = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    const port = Number(c?.ports?.broker);
    if (Number.isInteger(port) && port > 0) {
      const host = !c.host || c.host === "0.0.0.0" || c.host === "::" ? "127.0.0.1" : c.host;
      return `http://${host}:${port}`;
    }
  } catch {}
  return "http://127.0.0.1:43110";
}

/** Where `scout setup` keeps the operator attribution key. */
export function keyFile(env = process.env) {
  if (env.OPENSCOUT_ATTRIBUTION_KEY_FILE?.trim()) return env.OPENSCOUT_ATTRIBUTION_KEY_FILE.trim();
  const support = env.OPENSCOUT_SUPPORT_DIRECTORY?.trim() ||
    (process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "OpenScout")
      : path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "openscout"));
  return path.join(support, "runtime", "operator-attribution.key");
}

/** The key, or why there isn't one. Refuses a file others can read, as the runtime does. */
export function readKey(file = keyFile()) {
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > 256 || (st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid()))
        return { problem: "the operator key must be a file only you can read" };
      const key = fs.readFileSync(fd, "utf8").trim();
      return /^[a-f0-9]{64}$/.test(key) ? { key } : { problem: "the operator key isn't in the expected form" };
    } finally { fs.closeSync(fd); }
  } catch (e) {
    return { problem: e.code === "ENOENT" ? "there's no operator key on this host yet. Scout 0.5.4 or newer makes one when you run scout setup" : "the operator key couldn't be read" };
  }
}

/** The headers the runtime checks for an operator post. Matches core's signLocalAdminRequest. */
export function sign(key, { method, path: p, body = "", destinationKeyId, ts = Date.now(), nonce = randomBytes(16).toString("base64") }) {
  const payload = ["local-admin:v1", method.toUpperCase(), p, createHash("sha256").update(body).digest("hex"),
    destinationKeyId, String(ts), nonce].join("\n");
  return {
    "x-openscout-local-admin": createHmac("sha256", Buffer.from(key, "hex")).update(payload).digest("hex"),
    "x-openscout-local-admin-ts": String(ts),
    "x-openscout-local-admin-nonce": nonce,
  };
}

async function get(p, ms = 8e3, headers) {
  const res = await fetch(`${runtimeUrl()}${p}`, { headers, redirect: "error", signal: AbortSignal.timeout(ms) });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`${p}: ${res.status}`); }
  return res.json();
}

/** This host's runtime node: its id, and the key id a signed post is bound to. */
export async function nodeInfo() {
  const n = await get("/v1/node", 2500);
  if (typeof n?.id !== "string" || !n.id) throw new Error("the runtime didn't name its node");
  return { id: n.id, name: n.name || n.hostName || "", keyId: n.card?.keyId };
}

export async function up() {
  try { await nodeInfo(); return true; } catch { return false; }
}

/** Verify the current read path and local operator attribution without writing a record. */
export async function readiness({ key, problem } = readKey()) {
  const p = "/v1/conversation-projection?limit=1";
  const base = runtimeUrl();
  const [node, readable] = await Promise.all([
    nodeInfo().catch(() => null),
    get(p, 2500).then((d) => Array.isArray(d?.items), () => false),
  ]);
  let why = !node ? "Scout's runtime isn't answering"
    : !readable ? "the runtime isn't serving rooms"
    : !key ? problem || "posting isn't set up"
    : !node.keyId ? "the runtime didn't name its signing key"
    : null;
  if (!why) {
    try {
      const [signed, rejectsInvalidProof] = await Promise.all([
        get(p, 2500, sign(key, { method: "GET", path: p, destinationKeyId: node.keyId })),
        // A runtime that ignores proof headers can answer the signed read without authenticating it.
        fetch(base + p, { headers: { "x-openscout-local-admin": "invalid" }, redirect: "error", signal: AbortSignal.timeout(2500) })
          .then(async (r) => r.status === 401
            ? (await r.json())?.error === "invalid_local_admin_proof"
            : (await r.body?.cancel(), false)),
      ]);
      if (!Array.isArray(signed?.items) || !rejectsInvalidProof) throw new Error();
    } catch { why = "the runtime didn't verify the operator key"; }
  }
  return { listening: true, readable, writable: !why, runtime: node ? base : null,
    host: node?.name || null, nodeId: node?.id || null, canPost: !why, why };
}

const ROOM_KINDS = new Set(["channel", "direct", "group_direct"]);

/** Rooms, newest first: channels and direct conversations with agents. Observed harness sessions
 * are not Scout messages, so they stay out. */
export async function rooms(limit = 200) {
  const d = await get(`/v1/conversation-projection?limit=${limit}`);
  return d.items.filter((i) => ROOM_KINDS.has(i.kind) && i.conversationId).map((i) => ({
    id: i.conversationId,
    kind: i.kind === "channel" ? "channel" : "direct",
    title: (i.title || i.agentName || i.conversationId).replace(/\s*\(Vercel Board\)$/, ""),
    board: /\(Vercel Board\)$/.test(i.title || ""),
    agentId: i.agentId || null,
    agentName: i.agentName || null,
    preview: i.preview || "",
    lastAt: i.lastMessageAt || i.lastActivityAt || 0,
    unread: i.unreadCount || 0,
    state: i.activityState || null,
  }));
}

let names = { at: 0, map: new Map() };
/** Display names for actors, from the runtime's identity snapshot, refreshed at most every five minutes. */
async function actorNames() {
  if (Date.now() - names.at < 300e3) return names.map;
  try {
    const s = await get("/v1/snapshot?scope=identity", 20e3);
    const map = new Map();
    for (const a of Object.values(s.actors || {})) map.set(a.id, a.displayName || a.handle || a.id);
    names = { at: Date.now(), map };
  } catch {}
  return names.map;
}

/** A session actor's own name is its id ("Session Mwrgkgn6 Ewhgmu"); the room's agent name reads better. */
const sessionish = (id, name) => /^session-/.test(id) || /^Session [A-Za-z0-9]+ [A-Za-z0-9]+$/.test(name || "");

export async function messages(conversationId, { limit = 200, agentName = null } = {}) {
  const list = await get(`/v1/messages?conversationId=${encodeURIComponent(conversationId)}&limit=${limit}`);
  const map = await actorNames();
  return list.filter((m) => m.class === "agent" || m.class === "artifact").map((m) => ({
    id: m.id,
    actorId: m.actorId,
    name: m.actorId === "operator" ? "You"
      : agentName && sessionish(m.actorId, map.get(m.actorId)) ? agentName : map.get(m.actorId) || m.actorId,
    mine: m.actorId === "operator",
    body: m.body,
    at: m.createdAt,
    replyTo: m.replyToMessageId || null,
  })).sort((a, b) => a.at - b.at);
}

/**
 * Post as the operator. In a direct room the message goes to its agent as a consult, which wakes
 * the agent and opens a flight; in a channel it is a room message.
 */
export async function post({ room, body }, key) {
  const n = await nodeInfo();
  if (!n.keyId) throw new Error("the runtime didn't name its key, so a post can't be signed");
  const createdAt = Date.now(), id = `chat-${createdAt.toString(36)}-${randomBytes(4).toString("hex")}`;
  const [p, payload] = room.kind === "direct" && room.agentId
    ? ["/v1/deliver", { id, requesterId: "operator", requesterNodeId: n.id, targetAgentId: room.agentId, body,
      intent: "consult", ensureAwake: true, createdAt, messageMetadata: { source: "scout-chat" } }]
    : ["/v1/messages", { id, requestId: id, conversationId: room.id, actorId: "operator", originNodeId: n.id,
      class: "agent", body, visibility: "workspace", policy: "durable", createdAt, metadata: { source: "scout-chat" } }];
  const text = JSON.stringify(payload);
  const res = await fetch(`${runtimeUrl()}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...sign(key, { method: "POST", path: p, body: text, destinationKeyId: n.keyId }) },
    body: text,
    redirect: "error",
    signal: AbortSignal.timeout(15e3),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || out.message || `the runtime refused the post (${res.status})`);
  if (out.kind && out.kind !== "delivery") throw new Error(out.reason || out.message || "the runtime didn't deliver it");
  return { id };
}

/** Follow the runtime's event stream and call fn with each posted message's conversation id. */
export function follow(fn) {
  const lifetime = new AbortController();
  (async function loop(n = 0) {
    while (!lifetime.signal.aborted) {
      try {
        const res = await fetch(`${runtimeUrl()}/v1/events/stream`, { signal: lifetime.signal });
        if (!res.ok || !res.body) throw new Error(String(res.status));
        n = 0;
        let buf = "", ev = "";
        for await (const chunk of res.body) {
          buf += Buffer.from(chunk).toString("utf8");
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
            if (line.startsWith("event:")) ev = line.slice(6).trim();
            else if (line.startsWith("data:") && (ev === "message.posted" || ev === "message.corrected")) {
              try { const d = JSON.parse(line.slice(5)); fn(d.payload?.message?.conversationId || d.message?.conversationId || null); } catch {}
            } else if (!line) ev = "";
          }
        }
      } catch {}
      await sleep(Math.min(30e3, 1e3 * 2 ** Math.min(n++, 5)), undefined, { signal: lifetime.signal }).catch(() => {});
    }
  })();
  return () => lifetime.abort();
}
