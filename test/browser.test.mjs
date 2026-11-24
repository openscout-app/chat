import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "../server/serve.mjs";

let browser;
before(async () => { browser = await chromium.launch({ channel: "chrome" }); });
after(() => browser?.close());
const listen = (s) => new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${s.address().port}`)));
const close = (s) => new Promise((resolve) => { s.close(resolve); s.closeAllConnections(); });
const room = (conversationId, kind = "channel", fields = {}) => ({ conversationId, kind, title: conversationId, ...fields });
const msg = (id, body, createdAt = 1) => ({ id, body, createdAt, class: "agent", actorId: "reader" });
const reader = { id: "reader", kind: "agent", displayName: "Reader", capabilities: ["invoke"], authorityNodeId: "test-node" };
const readerMailbox = { id: "reader-inbox", agentId: "reader", nodeId: "test-node", transport: "mcp_poll",
  state: "registered", sessionId: "reader-session", metadata: { externalSession: true } };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { resolve, promise }; };

function messageEvent(f, conversationId) {
  for (const stream of f.streams)
    stream.write(`event: message.posted\ndata: ${JSON.stringify({ message: { conversationId } })}\n\n`);
}

// Exercise the actual page, local API, signed route selection and both SSE hops.
// Only the upstream runtime is a fixture; never read or write operator records.
async function fixture(t, settings = {}) {
  const f = Object.assign({ rooms: [], agents: {}, endpoints: [], messages: {}, writes: [], streams: new Set(),
    online: true, streamUp: true, readsUp: true, writable: true, statusReads: 0 }, settings);
  const upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture.invalid");
    const json = (code, data) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (!f.online) return json(503, {});
    if (url.pathname === "/v1/events/stream") {
      if (!f.streamUp) return json(503, {});
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": ready\n\n");
      f.streams.add(res);
      res.on("close", () => f.streams.delete(res));
      return;
    }
    if (url.pathname === "/v1/node") {
      f.statusReads++;
      return json(200, { id: "test-node", card: { keyId: "test-key" } });
    }
    if (url.pathname === "/v1/conversation-projection") {
      const proof = req.headers["x-openscout-local-admin"];
      if (!f.readsUp) return json(503, {});
      if (proof && (!f.writable || proof === "invalid")) return json(401, { error: "invalid_local_admin_proof" });
      return json(200, { items: f.rooms });
    }
    if (url.pathname === "/v1/endpoints") return json(200, { endpoints: f.endpoints });
    if (url.pathname === "/v1/snapshot") return json(200, { agents: f.agents, actors: {} });
    if (url.pathname === "/v1/messages" && req.method === "GET")
      return json(f.readsUp ? 200 : 503, f.messages[url.searchParams.get("conversationId")] || []);
    if (["/v1/deliver", "/v1/messages"].includes(url.pathname) && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const payload = JSON.parse(Buffer.concat(chunks));
      f.writes.push({ path: url.pathname, payload });
      if (f.gate) await f.gate.promise;
      if (url.pathname === "/v1/deliver") {
        if (f.refuse) return json(200, { kind: "rejected", accepted: false });
        if (!f.rooms.length) f.rooms = [room("direct", "direct", { agentId: payload.targetAgentId, agentName: "Reader" })];
        return json(202, { kind: "delivery", accepted: true, receipt: {
          targetAgentId: payload.targetAgentId, conversationId: "direct", messageId: "sent",
        } });
      }
      return json(200, { ok: true, message: { id: "sent" } });
    }
    json(404, {});
  });
  const original = process.env.SCOUT_RUNTIME_URL;
  process.env.SCOUT_RUNTIME_URL = await listen(upstream);
  const chat = createServer({ port: 0, key: randomBytes(32).toString("hex") });
  chat.on("request", (req) => { if (req.url === "/api/events") f.browserStream = req.socket; });
  f.url = await listen(chat);
  const context = await browser.newContext({ viewport: { width: 1000, height: 720 }, colorScheme: "light" });
  f.page = await context.newPage();
  f.page.setDefaultTimeout(5000);
  const errors = [];
  f.page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    f.gate?.resolve();
    await context.close();
    await close(chat);
    await close(upstream);
    if (original === undefined) delete process.env.SCOUT_RUNTIME_URL;
    else process.env.SCOUT_RUNTIME_URL = original;
    assert.deepEqual(errors, []);
  });
  return f;
}

test("a group post is guarded before ack and edits stay in the room that owns them", async (t) => {
  const f = await fixture(t, { rooms: [room("group", "group_direct"), room("other")], gate: deferred() });
  const p = f.page, field = p.getByRole("textbox", { name: "Post to room" });
  await p.goto(f.url + "/#group");
  await field.fill("first");
  await field.press("Shift+Enter");
  await field.press("x");
  await field.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  assert.equal(await field.inputValue(), "first\nx");
  assert.equal(f.writes.length, 0);
  await field.press("Enter");
  await field.press("Enter");
  await field.press("End");
  await field.pressSequentially(" next");
  assert.equal(await p.locator("#room-composer .send").isDisabled(), true);
  await p.getByRole("link", { name: "other" }).click();
  await field.fill("other draft");
  f.gate.resolve();
  await p.getByRole("link", { name: "group" }).click();
  await p.getByText("Posted to room", { exact: true }).waitFor();
  assert.equal(await field.inputValue(), " next");
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].path, "/v1/messages");
  assert.equal(f.writes[0].payload.body, "first\nx");
  await p.goBack();
  assert.equal(await field.inputValue(), "other draft");
});

test("an uncertain ask retries the same runtime request and acknowledges acceptance, not an answer", async (t) => {
  const f = await fixture(t, { rooms: [room("direct", "direct", { agentId: "reader", agentName: "Reader" })] });
  const p = f.page, field = p.getByRole("textbox", { name: "Ask Reader" });
  let loseAck = true;
  await p.route("**/api/rooms/direct/messages", async (route) => {
    if (!loseAck || route.request().method() !== "POST") return route.continue();
    await route.fetch();
    loseAck = false;
    await route.abort();
  });
  await p.goto(f.url);
  await field.fill("Read this");
  await field.press("Enter");
  await p.locator(".hint.error").waitFor();
  assert.equal(await field.inputValue(), "Read this");
  await field.press("Enter");
  await p.locator("#room-composer").getByText("Ask accepted by Reader", { exact: true }).waitFor();
  assert.equal(await field.inputValue(), "");
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[0].path, "/v1/deliver");
  assert.ok(f.writes[0].payload.requestId);
  assert.deepEqual(f.writes[0].payload, f.writes[1].payload);
  f.refuse = true;
  await field.fill("Different ask");
  await field.press("Enter");
  await p.locator(".hint.error").waitFor();
  assert.notEqual(f.writes[2].payload.requestId, f.writes[1].payload.requestId);
  assert.equal(await field.inputValue(), "Different ask");
});

test("restoring an uncertain draft reuses its request ID; submitting different text does not", async (t) => {
  const f = await fixture(t, { rooms: [room("direct", "direct", { agentId: "reader", agentName: "Reader" })] });
  const p = f.page, field = p.getByRole("textbox", { name: "Ask Reader" });
  await p.route("**/api/rooms/direct/messages", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fetch(); // Accepted by Scout; the browser gets no receipt.
    await route.abort();
  });
  await p.goto(f.url);
  await field.fill("Read this");
  const sendWithoutReceipt = async () => {
    await field.press("Enter");
    await p.getByText("No receipt. Send the same text to retry.", { exact: true }).waitFor();
  };
  await sendWithoutReceipt();
  await field.press("x");
  await field.press("Backspace");
  await sendWithoutReceipt();
  await field.pressSequentially("?");
  await sendWithoutReceipt();
  assert.equal(f.writes.length, 3);
  assert.ok(f.writes[0].payload.requestId);
  assert.deepEqual(f.writes[1], f.writes[0]);
  assert.equal(f.writes[2].payload.body, "Read this?");
  assert.notEqual(f.writes[2].payload.requestId, f.writes[0].payload.requestId);
});

test("a cold start distinguishes setup, no target and a real first ask", async (t) => {
  const f = await fixture(t, { online: false });
  const p = f.page;
  await p.setViewportSize({ width: 390, height: 730 });
  await p.goto(f.url);
  await p.locator("#setup-command").waitFor();
  assert.equal(await p.locator("#setup-command").textContent(), "npx github:openscout-app/chat setup");
  await p.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await p.getByRole("button", { name: "Copy", exact: true }).click();
  assert.equal(await p.evaluate(() => navigator.clipboard.readText()), await p.locator("#setup-command").textContent());
  assert.equal(await p.getByText("No rooms yet", { exact: true }).isVisible(), false);
  f.online = true;
  f.streamUp = false; // Check again must not wait for EventSource backoff.
  await p.getByRole("button", { name: "Check again" }).click();
  await p.getByText("Connect an agent to Scout to start a room.").waitFor();
  assert.equal(await p.getByRole("button", { name: "Ask an agent" }).isVisible(), false);
  f.agents.reader = reader;
  f.endpoints = [readerMailbox];
  f.streamUp = true; // The upstream connection event refreshes the real target list.
  await p.getByRole("button", { name: "Ask an agent" }).click();
  const field = p.getByRole("textbox", { name: "Ask Reader" });
  await field.fill("Start a conversation");
  await field.press("Enter");
  await p.locator("#room-composer").getByText("Ask accepted by Reader", { exact: true }).waitFor();
  assert.equal(new URL(p.url()).hash, "#direct");
  assert.equal(await p.locator(".rooms").isVisible(), false);
  assert.deepEqual(f.writes.map((w) => [w.path, w.payload.targetAgentId]), [["/v1/deliver", "reader"]]);
});

test("linked, remembered and sole rooms respect index history and the 720px breakpoint", async (t) => {
  const f = await fixture(t, { rooms: [room("one"), room("two")] });
  const p = f.page;
  await p.setViewportSize({ width: 719, height: 700 });
  await p.goto(f.url);
  const two = p.getByRole("link", { name: "two" });
  await two.focus();
  await two.press("Enter");
  await p.locator(".room-head h1").waitFor();
  assert.equal(await p.locator(".rooms").isVisible(), false);
  assert.equal(new URL(p.url()).hash, "#two");
  await p.getByRole("link", { name: "Rooms", exact: true }).click();
  await two.waitFor();
  assert.equal(await two.evaluate((a) => a === document.activeElement), true);
  await p.goForward();
  await p.locator(".room-head h1").waitFor();
  await p.goto(f.url);
  await p.waitForURL("**/#two");
  await p.goto(f.url + "/?message=gone#one");
  await p.getByRole("status").filter({ hasText: "The linked message is unavailable in this discussion." }).waitFor();
  assert.equal(await p.locator(".room-head h1").textContent(), "one");
  await p.setViewportSize({ width: 720, height: 700 });
  await two.waitFor();
  assert.equal((await p.locator(".rooms").boundingBox()).width, 280);
  assert.equal(await p.locator(".rooms-back").isVisible(), false);
  f.rooms = [room("sole")];
  await p.goto(f.url);
  await p.waitForURL("**/#sole");
});

test("upstream reconnect keeps the good DOM, rechecks readiness and catches up the active room", async (t) => {
  const f = await fixture(t, { rooms: [room("one")], messages: { one: [msg("a", "Keep this text"), msg("b", "Original", 2)] } });
  const p = f.page;
  await p.goto(f.url);
  await p.getByText("Keep this text").waitFor();
  await p.locator(".log").focus();
  await p.locator("#messages .body").first().evaluate((body) => {
    const range = document.createRange();
    range.selectNodeContents(body);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    window.firstArticle = body.closest("article");
  });
  f.streamUp = f.readsUp = false;
  for (const res of f.streams) res.end();
  await p.getByText("Reconnecting…", { exact: true }).waitFor();
  await p.waitForFunction(() => document.querySelector("textarea").readOnly);
  assert.equal(await p.getByText("No rooms yet", { exact: true }).isVisible(), false);
  assert.equal(await p.getByRole("link", { name: "one" }).isVisible(), true);
  assert.equal(await p.locator("#messages article").count(), 2);
  f.streamUp = f.readsUp = true;
  f.messages.one = [msg("a", "Keep this text"), msg("b", "Corrected", 2), msg("c", "Missed while away", 3)];
  await p.getByText("Missed while away").waitFor();
  await p.locator("#recovery").waitFor({ state: "hidden" });
  assert.equal(await p.locator("article").nth(1).locator(".body").textContent(), "Corrected");
  assert.equal(await p.evaluate(() => window.firstArticle === document.querySelector("article")), true);
  assert.equal(await p.evaluate(() => getSelection().toString()), "Keep this text");
  assert.equal(await p.evaluate(() => document.activeElement.className), "log");
  assert.equal(await p.getByRole("textbox", { name: "Post to room" }).isEditable(), true);
});

test("reopening the browser stream repairs missed data even if the runtime stream stayed up", async (t) => {
  const f = await fixture(t, { rooms: [room("one")], messages: { one: [msg("a", "Before")] } });
  const p = f.page;
  await p.goto(f.url);
  await p.getByText("Before", { exact: true }).waitFor();
  const reads = f.statusReads;
  f.browserStream.destroy();
  await p.getByText("Reconnecting…", { exact: true }).waitFor();
  f.writable = false;
  f.messages.one.push(msg("b", "After", 2));
  await p.getByText("After", { exact: true }).waitFor();
  await p.waitForFunction(() => document.querySelector("textarea").readOnly);
  assert.ok(f.statusReads > reads);
});

test("metadata clears the contrast floor in both themes and the focused composer keeps its ring", async (t) => {
  const f = await fixture(t, { rooms: [room("one", "channel", { lastMessageAt: Date.now() })],
    messages: { one: [msg("a", "A long message. ".repeat(45))] } });
  const p = f.page;
  await p.setViewportSize({ width: 1240, height: 700 });
  await p.goto(f.url);
  await p.locator("article").waitFor();
  assert.equal((await p.locator("article").boundingBox()).width, 720);
  for (const colorScheme of ["light", "dark"]) {
    await p.emulateMedia({ colorScheme });
    await p.getByRole("textbox", { name: "Post to room" }).focus();
    const { timestamp, selected, ring } = await p.evaluate(() => {
      const style = (s) => getComputedStyle(document.querySelector(s));
      const rgb = (str) => str.match(/[\d.]+/g).map(Number);
      const lum = (color) => color.slice(0, 3).reduce((sum, v, i) => {
        const c = v / 255;
        return sum + [0.2126, 0.7152, 0.0722][i] * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      }, 0);
      const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
      const panel = rgb(style(".rooms").backgroundColor), fill = rgb(style(".item").backgroundColor);
      const active = panel.map((v, i) => fill[i] * fill[3] + v * (1 - fill[3]));
      return { timestamp: contrast(rgb(style(".who time").color), panel),
        selected: contrast(rgb(style(".item time").color), active), ring: style(".field").outline };
    });
    assert.ok(timestamp >= 4.5 && selected >= 4.5, `${colorScheme}: ${timestamp} on panel; ${selected} on selection`);
    assert.match(ring, /solid 2px/);
  }
});

test("replacing the submitted selection preserves the new draft even when it has the same prefix", async (t) => {
  const f = await fixture(t, { rooms: [room("one")], gate: deferred() });
  const p = f.page, field = p.getByRole("textbox", { name: "Post to room" });
  await p.goto(f.url);
  await field.fill("Review");
  await field.press("Enter");
  await field.evaluate((ta) => ta.select());
  await p.keyboard.insertText("Review the second change");
  f.gate.resolve();
  await p.getByText("Posted to room", { exact: true }).waitFor();
  assert.equal(await field.inputValue(), "Review the second change");
});

test("a changed recipient cannot turn a room post into an unnoticed ask", async (t) => {
  const f = await fixture(t, { rooms: [room("one", "group_direct")] });
  const p = f.page, field = p.getByRole("textbox", { name: "Post to room" });
  await p.goto(f.url);
  await field.fill("For the room");
  Object.assign(f.rooms[0], { agentId: "reader", agentName: "Reader" });
  await field.press("Enter");
  const updated = p.getByRole("textbox", { name: "Ask Reader" });
  await updated.waitFor();
  assert.equal(await updated.inputValue(), "For the room");
  assert.equal(f.writes.length, 0);
});

for (const timing of ["before", "after"]) {
  test(`a first ask keeps its draft and request ID when the HTTP receipt is lost ${timing} entering the new room`, async (t) => {
    const f = await fixture(t, { agents: { reader }, endpoints: [readerMailbox] });
    const p = f.page, loseReceipt = deferred();
    t.after(() => loseReceipt.resolve());
    await p.route("**/api/ask", async (route) => {
      // Scout accepted and created the room. Delay only the browser's HTTP receipt.
      await route.fetch();
      messageEvent(f, "direct");
      await loseReceipt.promise;
      await route.abort();
    });
    await p.goto(f.url);
    await p.getByRole("button", { name: "Ask an agent" }).click();
    const dialog = p.getByRole("dialog");
    const original = dialog.getByRole("textbox", { name: "Ask Reader" });
    await original.fill("Read the draft");
    await original.press("Enter");
    const link = p.locator('.item[data-id="direct"]');
    await link.waitFor();
    if (timing === "before") {
      loseReceipt.resolve();
      await dialog.getByText(/No receipt/).waitFor();
    }
    await dialog.getByRole("button", { name: "Close" }).click();
    await link.click();
    const field = p.locator("#room-composer textarea");
    assert.equal(await field.inputValue(), "Read the draft");
    if (timing === "after") {
      assert.ok(await p.locator("#room-composer .send").isDisabled());
      await field.press("Enter");
      assert.equal(f.writes.length, 1);
      loseReceipt.resolve();
    }
    await p.locator("#room-composer").getByText(/No receipt/).waitFor();
    await field.press("Enter");
    await p.getByText("Ask accepted by Reader", { exact: true }).waitFor();
    assert.equal(await field.inputValue(), "");
    assert.equal(f.writes.length, 2);
    assert.ok(f.writes[0].payload.requestId);
    assert.deepEqual(f.writes[0], f.writes[1], "the broker sees one logical ask");
  });
}

for (const method of ["native move", "insertBefore"]) {
  test(`an SSE room reorder preserves link focus and selection (${method})`, async (t) => {
    const f = await fixture(t, { rooms: [room("Alpha"), room("Bravo"), room("Charlie")] });
    const p = f.page;
    await p.goto(f.url);
    if (method === "insertBefore") await p.locator("#channels > div").evaluate((list) => { list.moveBefore = undefined; });
    const bravo = p.getByRole("link", { name: "Bravo" });
    await bravo.focus();
    await bravo.evaluate((link) => {
      const text = link.querySelector(".title span").firstChild;
      getSelection().setBaseAndExtent(text, 4, text, 1);
    });
    f.rooms = [f.rooms[1], f.rooms[2], f.rooms[0]];
    messageEvent(f, "Bravo");
    await p.waitForFunction(() => document.querySelector(".item").dataset.id === "Bravo");
    assert.deepEqual(await bravo.evaluate((link) => {
      const text = link.querySelector(".title span").firstChild, s = getSelection();
      return [document.activeElement === link, s.anchorNode === text, s.anchorOffset, s.focusNode === text, s.focusOffset, s.toString()];
    }), [true, true, 4, true, 1, "rav"]);
  });
}

test("a focused draft stays focused and cannot submit during a runtime outage", async (t) => {
  const f = await fixture(t, { rooms: [room("one")] });
  const p = f.page, field = p.getByRole("textbox", { name: "Post to room" });
  await p.goto(f.url);
  await field.fill("Not sent yet");
  await field.evaluate((ta) => ta.setSelectionRange(4, 8));
  const focusAndSelection = () => field.evaluate((ta) => [document.activeElement === ta, ta.selectionStart, ta.selectionEnd]);
  f.online = false;
  for (const stream of f.streams) stream.end();
  await p.waitForFunction(() => document.querySelector("#room-composer textarea").readOnly);
  assert.deepEqual(await focusAndSelection(), [true, 4, 8]);
  assert.ok(await p.locator("#room-composer .send").isDisabled());
  await p.keyboard.press("Enter");
  assert.equal(f.writes.length, 0);
  f.online = true;
  await p.waitForFunction(() => !document.querySelector("#room-composer textarea").readOnly);
  assert.deepEqual(await focusAndSelection(), [true, 4, 8]);
  assert.equal(await field.inputValue(), "Not sent yet");
  await p.keyboard.press("Enter");
  await p.getByText("Posted to room", { exact: true }).waitFor();
  assert.equal(f.writes.length, 1);
});
