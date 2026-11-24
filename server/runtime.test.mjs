import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { askTargets, keyFile, messages, post, readKey, sign } from "./runtime.mjs";

test("opens an older reply only in its own conversation", async (t) => {
  const message = { id: "old/reply", conversationId: "room-a", class: "agent", actorId: "alex", createdAt: 1, body: "Earlier reply" };
  const recent = { ...message, id: "recent", createdAt: 2 };
  const paths = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const { pathname, searchParams } = new URL(url);
    paths.push(pathname);
    if (pathname === "/v1/messages") return Response.json(searchParams.get("conversationId") === "room-a" ? [recent] : []);
    if (pathname === "/v1/messages/old%2Freply") return Response.json({ message });
    if (pathname === "/v1/snapshot") return Response.json({ actors: {} });
    return new Response(null, { status: 404 });
  });
  assert.deepEqual((await messages("room-a", { messageId: message.id })).map((m) => m.id), [message.id, recent.id]);
  assert.deepEqual(await messages("room-b", { messageId: message.id }), []);
  assert.deepEqual((await messages("room-a", { messageId: "missing" })).map((m) => m.id), [recent.id]);
  paths.length = 0;
  await messages("room-a", { messageId: recent.id });
  assert.ok(!paths.includes("/v1/messages/recent"));
});

test("signs a post the way Scout's runtime verifies it", () => {
  // Computed with signLocalAdminRequest from Scout core (packages/runtime/src/mesh-access-local-auth.ts).
  const headers = sign("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", {
    method: "post", path: "/v1/deliver", body: '{"body":"hello"}', destinationKeyId: "key-test",
    ts: 1790000000000, nonce: "AAAAAAAAAAAAAAAAAAAAAA==",
  });
  assert.deepEqual(headers, {
    "x-openscout-local-admin": "fe95cccf5cbcfc8c7b598c66675c0cf512377ddd6409b099d1cedf891b1f0f48",
    "x-openscout-local-admin-ts": "1790000000000",
    "x-openscout-local-admin-nonce": "AAAAAAAAAAAAAAAAAAAAAA==",
  });
});

test("finds the key scout setup made, or the one named explicitly", () => {
  assert.equal(keyFile({ OPENSCOUT_ATTRIBUTION_KEY_FILE: "/x/key" }), "/x/key");
  assert.equal(keyFile({ OPENSCOUT_SUPPORT_DIRECTORY: "/s" }), path.join("/s", "runtime", "operator-attribution.key"));
});

test("reads only an owner-only key, and says why not otherwise", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scout-chat-"));
  const f = path.join(dir, "k");
  assert.match(readKey(f).problem, /no operator key.*scout setup/);
  fs.writeFileSync(f, "ab".repeat(32) + "\n", { mode: 0o644 });
  fs.chmodSync(f, 0o644);
  assert.match(readKey(f).problem, /only you/);
  fs.chmodSync(f, 0o600);
  assert.equal(readKey(f).key, "ab".repeat(32));
  fs.writeFileSync(f, "not a key");
  assert.match(readKey(f).problem, /expected form/);
  fs.rmSync(dir, { recursive: true });
});

function targetInventory(t, agents, endpoints, sessions = [], hostName) {
  const nodeId = "node";
  const paths = {
    "/v1/node": { id: nodeId, hostName },
    "/v1/snapshot": { agents: Object.fromEntries(agents.map(({ id, ...rest }) =>
      [id, { id, kind: "agent", authorityNodeId: nodeId, capabilities: ["chat"], ...rest }])) },
    // Even the dead tmux session below looks available on Scout 0.5.4's Home.
    "/v1/home": { agents: agents.map(({ id }) => ({ id, state: "available", reachable: true })) },
    "/v1/endpoints": { endpoints: endpoints.map((e, i) => ({ id: `endpoint-${i}`, nodeId, ...e })) },
    "/v1/pairing/sessions": sessions,
  };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(init?.method ?? "GET", "GET", "discovery must never dispatch an ask");
    const value = paths[new URL(url).pathname];
    return value ? Response.json(value) : new Response(null, { status: 404 });
  });
}

test("first asks exclude a Home-reachable idle tmux registration with no live session or verified launcher", async (t) => {
  const mailbox = { transport: "mcp_poll", state: "registered", sessionId: "inbox", metadata: { externalSession: true } };
  const gone = { transport: "tmux", harness: "codex", state: "idle", sessionId: "missing-session" };
  targetInventory(t, [{ id: "idle-card", wakePolicy: "on_demand" }, { id: "policy-only", wakePolicy: "keep_warm" },
    { id: "reader" }, { id: "preferred-inbox" }, { id: "ambiguous" }, { id: "listener", capabilities: ["listen"] }], [
    { ...gone, agentId: "idle-card" }, { ...mailbox, agentId: "reader" }, { ...mailbox, agentId: "listener" },
    { ...mailbox, agentId: "ambiguous" }, { ...gone, preferred: true, agentId: "ambiguous" },
    { ...gone, agentId: "preferred-inbox" }, { ...mailbox, preferred: true, agentId: "preferred-inbox" },
  ]);
  assert.deepEqual((await askTargets()).map((a) => a.id), ["preferred-inbox", "reader"]);
});

test("an attached tmux pane needs a live process on the broker's own host", async (t) => {
  const attached = (agentId, pid) => ({ agentId, transport: "tmux", state: "idle", pane: "%1",
    metadata: { attachedLive: true, livePid: pid } });
  const endpoints = [attached("running", process.pid), attached("exited", 2 ** 30), attached("no-pid", undefined)];
  const original = process.env.SCOUT_RUNTIME_URL;
  t.after(() => {
    if (original === undefined) delete process.env.SCOUT_RUNTIME_URL;
    else process.env.SCOUT_RUNTIME_URL = original;
  });
  process.env.SCOUT_RUNTIME_URL = "http://127.0.0.1";
  targetInventory(t, endpoints.map((e) => ({ id: e.agentId })), endpoints, [], os.hostname());
  assert.deepEqual((await askTargets()).map((a) => a.id), ["running"]);
  process.env.SCOUT_RUNTIME_URL = "https://runtime.invalid";
  assert.deepEqual(await askTargets(), [], "a local PID cannot prove a remote endpoint is alive");
});

test("a pairing route must still name a live session and a channel must have a current heartbeat", async (t) => {
  const pair = (id) => ({ agentId: id, transport: "pairing_bridge", sessionId: id, state: "idle" });
  const channel = (id, age) => ({ agentId: id, transport: "claude_channel", state: "idle", metadata: { lastSeenAt: Date.now() - age } });
  const endpoints = [pair("paired"), pair("closed"), pair("gone"), channel("fresh", 1_000), channel("expired", 46_000)];
  targetInventory(t, endpoints.map((e) => ({ id: e.agentId })), endpoints, [
    { externalSessionId: "paired", status: "idle" }, { externalSessionId: "closed", status: "closed" },
  ]);
  assert.deepEqual((await askTargets()).map((a) => a.id), ["fresh", "paired"]);
});

test("a failed pairing check neither hides a confirmed mailbox nor reports an unknown inventory as empty", async (t) => {
  const bridge = { agentId: "paired", transport: "pairing_bridge", sessionId: "session", state: "idle" };
  const endpoints = [bridge, { agentId: "reader", transport: "mcp_poll", state: "registered", metadata: { externalSession: true } }];
  targetInventory(t, [{ id: "paired" }, { id: "reader" }], endpoints, null);
  assert.deepEqual((await askTargets()).map((a) => a.id), ["reader"]);
  // The fixture answers 404 for the pairing inventory. Without an independent
  // receive route Chat should show “couldn’t check”, not “no agents”.
  t.mock.restoreAll();
  targetInventory(t, [{ id: "paired" }], [bridge], null);
  await assert.rejects(askTargets(), /pairing\/sessions: 404/);
});

test("receipt names the accepted target and rejects unconfirmed responses on either route", async (t) => {
  let response = { kind: "delivery", accepted: true, receipt: { messageId: "result", conversationId: "room", targetAgentId: "actual" } };
  t.mock.method(globalThis, "fetch", async (url) => Response.json(
    new URL(url).pathname === "/v1/node" ? { id: "node", card: { keyId: "key" } } : response));
  const input = { target: { id: "requested", name: "Requested" }, requestId: "request", body: "Hello" };
  const key = randomBytes(32).toString("hex");
  assert.deepEqual(await post(input, key), { kind: "ask", agent: "actual", requestId: "request", conversationId: "room", id: "result" });
  for (const invalid of [{}, { kind: "delivery", accepted: false }, { kind: "question" }]) {
    response = invalid;
    await assert.rejects(post(input, key), /confirm acceptance/);
    await assert.rejects(post({ ...input, target: null, conversationId: "room" }, key), /confirm the post/);
  }
});
