import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { hello, portOptions, start } from "./local.mjs";
import { createServer, serve } from "./serve.mjs";

// Never talk to the operator's runtime from a launcher fixture.
process.env.SCOUT_RUNTIME_URL = "http://127.0.0.1:1";

const listen = (server, port = 0) => new Promise((resolve, reject) =>
  server.once("error", reject).listen(port, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => {
  server.close(resolve);
  server.closeAllConnections();
});
const api = (port, route) => fetch(`http://127.0.0.1:${port}/api/${route}`).then((r) => r.json());

test("explicit ports are validated without silently falling back", () => {
  assert.deepEqual(portOptions([], undefined), { first: 4804, strict: false });
  assert.deepEqual(portOptions([], "65535"), { first: 65535, strict: true });
  assert.deepEqual(portOptions(["--port", "49123"], "43210"), { first: 49123, strict: true });
  assert.deepEqual(portOptions(["--port=49123"], undefined), { first: 49123, strict: true });
  for (const args of [["--port="], ["--port"], ["--port", "0"], ["--port", "65536"], ["--port", "1e3"], ["--port", "--no-open"]])
    assert.throws(() => portOptions(args, "43210"), /takes a port number/);
});

test("automatic launches reuse a matching fallback even after the preferred port opens", async (t) => {
  const foreign = http.createServer((_, res) => res.end(JSON.stringify({ app: "scout-chat", canPost: true })));
  const first = await listen(foreign);
  t.after(() => close(foreign));
  const runtimeUrl = `http://127.0.0.1:${first}/fixture`;
  process.env.SCOUT_RUNTIME_URL = runtimeUrl;
  t.after(() => { process.env.SCOUT_RUNTIME_URL = "http://127.0.0.1:1"; });
  await assert.rejects(start({ first, strict: true, serve }), /port .* is taken/);
  const fallback = await start({ first, serve });
  assert.ok(fallback.server);
  t.after(() => close(fallback.server));
  assert.ok(fallback.port > first);
  assert.deepEqual(await start({ first, serve }), { ...fallback, reused: true, server: null });
  await close(foreign);
  assert.deepEqual(await start({ first, serve }), { ...fallback, reused: true, server: null });

  // A separate process keeps the identity of the runtime it was launched against.
  const originalIdentity = hello();
  process.env.SCOUT_RUNTIME_URL = "http://127.0.0.1:2";
  try {
    const occupied = http.createServer((_, res) => res.end(JSON.stringify(originalIdentity)));
    await listen(occupied, first);
    t.after(() => close(occupied));
    await assert.rejects(start({ first, strict: true, serve }), /port .* is taken/);
    assert.notEqual(hello().instance, originalIdentity.instance);
  } finally { process.env.SCOUT_RUNTIME_URL = runtimeUrl; }
});

test("concurrent launches converge on one listener", async (t) => {
  const holding = http.createServer();
  const first = await listen(holding);
  await close(holding);
  process.env.SCOUT_RUNTIME_URL = `http://127.0.0.1:${first}/fixture`;
  t.after(() => { process.env.SCOUT_RUNTIME_URL = "http://127.0.0.1:1"; });
  const results = await Promise.all([start({ first, serve }), start({ first, serve })]);
  for (const result of results) if (result.server) t.after(() => close(result.server));
  assert.equal(results[0].port, results[1].port);
  assert.equal(results.filter((r) => r.reused).length, 1);
});


test("hello is independent of the runtime; status tracks read, attribution, outage and recovery", async (t) => {
  let nodeId = "runtime-a", readable = true, proof = "verified";
  const fixture = () => http.createServer((req, res) => {
    const reply = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/node") return reply(200, { id: nodeId, name: "fixture", card: { keyId: "fixture-key" } });
    if (req.url === "/v1/conversation-projection?limit=1") {
      const signed = req.headers["x-openscout-local-admin"];
      if (!readable) return reply(503, {});
      if (signed && proof !== "ignored" && (signed === "invalid" || proof === "denied"))
        return reply(401, { error: "invalid_local_admin_proof" });
      return reply(200, { items: [] });
    }
    reply(404, {});
  });
  let runtime = fixture();
  const runtimePort = await listen(runtime);
  process.env.SCOUT_RUNTIME_URL = `http://127.0.0.1:${runtimePort}`;
  t.after(() => close(runtime));
  const server = createServer({ port: 0, key: "ab".repeat(32) });
  const port = await listen(server);
  t.after(() => close(server));
  const identity = await api(port, "hello");
  assert.equal(identity.app, "scout-chat");
  const status = () => api(port, "status");
  assert.deepEqual(await status(), { listening: true, readable: true, writable: true,
    runtime: process.env.SCOUT_RUNTIME_URL, host: "fixture", nodeId, canPost: true, why: null });
  proof = "denied";
  assert.equal((await status()).writable, false);
  proof = "ignored";
  assert.equal((await status()).canPost, false);
  proof = "verified";
  readable = false;
  assert.equal((await status()).readable, false);
  assert.equal((await status()).nodeId, nodeId);
  readable = true;
  await close(runtime);
  assert.deepEqual(await api(port, "hello"), identity);
  assert.deepEqual(await status(), { listening: true, readable: false, writable: false,
    runtime: null, host: null, nodeId: null, canPost: false, why: "Scout's runtime isn't answering" });
  nodeId = "runtime-b";
  runtime = fixture();
  await listen(runtime, runtimePort);
  assert.equal((await status()).nodeId, nodeId);
  assert.equal((await status()).writable, true);
});
