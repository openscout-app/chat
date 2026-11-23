import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { keyFile, readKey, sign } from "./runtime.mjs";

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
  assert.match(readKey(f).problem, /set up/);
  fs.writeFileSync(f, "ab".repeat(32) + "\n", { mode: 0o644 });
  fs.chmodSync(f, 0o644);
  assert.match(readKey(f).problem, /only you/);
  fs.chmodSync(f, 0o600);
  assert.equal(readKey(f).key, "ab".repeat(32));
  fs.writeFileSync(f, "not a key");
  assert.match(readKey(f).problem, /expected form/);
  fs.rmSync(dir, { recursive: true });
});
