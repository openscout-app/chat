import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { allowedWrite, createServer, sameHost } from "./serve.mjs";

import { createIntegrations } from "./integrations.mjs";
test("answers only to its own host and port", () => {
  assert.ok(sameHost("127.0.0.1:4802", 4802));
  assert.ok(sameHost("localhost:4802", 4802));
  assert.ok(!sameHost("localhost:4803", 4802));
  assert.ok(!sameHost("evil.example:4802", 4802)); // a DNS name pointed at 127.0.0.1
  assert.ok(!sameHost(undefined, 4802));
});

test("takes a post only from its own page", () => {
  const ok = { host: "localhost:4802", origin: "http://localhost:4802" };
  assert.ok(allowedWrite(ok, 4802));
  assert.ok(allowedWrite({ host: "127.0.0.1:4802", origin: "http://127.0.0.1:4802" }, 4802));
  assert.ok(!allowedWrite({ host: "localhost:4802" }, 4802), "no Origin");
  assert.ok(!allowedWrite({ host: "localhost:4802", origin: "https://evil.example" }, 4802), "another site");
  assert.ok(!allowedWrite({ host: "localhost:4802", origin: "null" }, 4802), "a sandboxed frame");
  assert.ok(!allowedWrite({ host: "localhost:4802", origin: "http://localhost:4803" }, 4802), "another local port");
});

test("integration routes enforce the write guard and delegate only valid inputs", async (t) => {
  const calls = [];
  let oldBoard = true;
  const integrations = createIntegrations({
    up: async () => true,
    find: () => "fake-scout",
    hasCompanion: () => false,
    run: async (_bin, argv) => {
      calls.push(argv);
      if (argv[1] === "status") return oldBoard ? { ok: false, stderr: "Integration setup operation not found." } : { ok: true };
      if (argv[1] === "--help") return { ok: true, stdout: "scout integration setup slack" };
      if (argv[1] === "setup") return { ok: true, stdout: JSON.stringify({ operation: { id: "slack-setup", revision: 1 }, extra: "private-output" }) };
      return { ok: true, stdout: "private-output" };
    },
  });
  const server = createServer({ port: 0, integrations });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const endpoint = `${origin}/api/integrations`;
  const post = (kind, data, headers = { origin, "content-type": "application/json" }) => fetch(`${endpoint}/${kind}`, {
    method: "POST", headers, body: typeof data === "string" ? data : JSON.stringify(data),
  });
  for (const [kind, data] of [["board", { team: "team_demo", credential: "secret_cli:board-demo" }], ["slack", { project: "/project" }]]) {
    for (const headers of [
      { "content-type": "application/json" },
      { origin: "https://example.com", "content-type": "application/json" },
      { origin: `http://localhost:${port}`, "content-type": "application/json" },
      { origin, "content-type": "text/plain" },
      { origin, "content-type": "application/json-other" },
    ]) assert.equal((await post(kind, data, headers)).status, 403);
    const wrongHost = await new Promise((resolve, reject) => {
      const req = request(`${endpoint}/${kind}`, {
        method: "POST", headers: { host: "invalid.example", origin, "content-type": "application/json" },
      }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject).end(JSON.stringify(data));
    });
    assert.equal(wrongHost, 421);
    assert.equal((await post(kind, "{bad JSON")).status, 400);
    assert.equal((await post(kind, null)).status, 400);
  }
  const fakeToken = "vcp_fake_test_token_do_not_use";
  for (const credential of [fakeToken, `secret_cli:${fakeToken}`, "secret_cli:abcdefghijklmnopqrstuvwxyz", "env:VERCEL_TOKEN"]) {
    const response = await post("board", { team: "team_demo", credential });
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /vcp_fake|abcdefghijklmnopqrstuvwxyz|VERCEL_TOKEN/);
  }
  const boardUrl = "https://api.vercel.com/v1/messageboard/boards/scout?teamId=team_demo";
  const credential = "secret_cli:board-demo";
  assert.equal((await post("board", { url: `${boardUrl}&token=${fakeToken}`, credential })).status, 400);
  assert.equal(calls.length, 0, "rejected requests do not run Scout");

  const support = await (await fetch(endpoint)).json();
  assert.equal(support.board.available, false);
  assert.match(support.board.message, /Board needs Scout 0\.5\.4 or newer/);
  assert.equal(support.slack.available, true);
  assert.match(support.slack.message, /Slack companion is unavailable/);
  assert.equal((await post("board", { team: "team_demo", credential })).status, 409);
  assert.ok(!calls.some((argv) => argv[1] === "connect"));

  oldBoard = false;
  for (const [target, flag, value] of [[{ team: "team_demo" }, "--team", "team_demo"], [{ url: boardUrl }, "--url", boardUrl]]) {
    const response = await post("board", { ...target, credential });
    assert.equal(response.status, 200);
    assert.deepEqual(calls.at(-1), ["integration", "connect", "vercel-board", flag, value, "--credential", credential]);
    assert.doesNotMatch(await response.text(), /private-output|board-demo/);
  }
  const slack = await post("slack", { project: "/project", agent: "my-agent" });
  assert.equal(slack.status, 200);
  assert.deepEqual(calls.at(-1), ["integration", "setup", "slack", "--project", "/project", "--agent", "my-agent", "--json"]);
  const receipt = await slack.json();
  assert.match(receipt.steps[0], /status slack-setup/);
  assert.match(receipt.steps[2], /manifest slack-setup --json/);
  assert.match(receipt.steps.at(-1), /verify slack-setup/);
  assert.doesNotMatch(JSON.stringify(receipt), /private-output/);
});
