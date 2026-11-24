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

test("first asks offer only registered agents that can chat and are live or wakeable", async (t) => {
  const agent = (id, data) => ({ kind: "agent", id, capabilities: ["chat"], wakePolicy: "manual", ...data });
  const snapshot = { agents: {
    awake: agent("awake"), wakeable: agent("wakeable", { wakePolicy: "on_demand" }),
    offline: agent("offline"), stale: agent("stale"), unrelated: agent("unrelated", { capabilities: ["listen"] }),
  } };
  const endpoints = [{ agentId: "awake", state: "idle" }, { agentId: "stale", state: "stopped" }, { agentId: "unrelated", state: "active" }];
  t.mock.method(globalThis, "fetch", async (url) => Response.json(new URL(url).pathname === "/v1/endpoints" ? { endpoints } : snapshot));
  assert.deepEqual((await askTargets()).map((a) => a.id), ["awake", "wakeable"]);
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
