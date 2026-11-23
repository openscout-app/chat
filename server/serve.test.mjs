import assert from "node:assert/strict";
import test from "node:test";
import { allowedWrite, sameHost } from "./serve.mjs";

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
