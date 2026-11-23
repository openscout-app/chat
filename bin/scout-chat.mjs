#!/usr/bin/env node
// npx github:openscout-app/chat [--port 4802] [--no-open]       start Scout Chat and open it
// npx github:openscout-app/chat setup                            start Scout's runtime if it isn't up
// npx github:openscout-app/chat connect board --team <team> --credential <ref>
// npx github:openscout-app/chat connect slack --project <path>
// npx github:openscout-app/chat status
import { execFile, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const HELP = `Usage:
  scout-chat [--port <n>] [--no-open]
      Your rooms with your agents, at http://localhost:4802: channels, direct conversations, and
      the rooms Scout keeps for a Vercel Board. What you write goes through Scout's runtime, in your
      name.

  scout-chat setup
      Start Scout's runtime on this host if it isn't up (scout setup). Scout comes with Scout Chat;
      its runtime runs on Bun.

  scout-chat connect board --team <team ID or slug> --credential secret_cli:<entry> [--board <name>]
      Follow a Vercel Board. Each Board channel becomes a room here; a task you claim for an agent
      becomes an ask, and its answer goes back to the Board. Store the Vercel token first with
      secret set <entry>; the token itself is never passed on the command line.

  scout-chat connect slack --project <path> [--agent <id>]
      Start Slack setup for a project's agent: prints the Slack app manifest and the next steps.
      Mentions and DMs then reach that agent, and each Slack thread stays one conversation.

  scout-chat status
      Is the runtime up, can Chat post in your name, and which connections exist.`;
if (args.includes("--help") || args.includes("-h")) { console.log(HELP); process.exit(0); }
const fail = (m) => { console.error(`scout-chat: ${m}`); process.exit(1); };

const exe = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { return null; } };
function onPath(name) {
  for (const d of [...(process.env.PATH || "").split(":"), path.join(os.homedir(), ".bun", "bin"), path.join(os.homedir(), ".local", "bin")]) {
    const p = d && exe(path.join(d, name));
    if (p) return p;
  }
  return null;
}
function findScout() {
  if (process.env.SCOUT_BIN) return process.env.SCOUT_BIN;
  try { return onPath("scout") || path.join(path.dirname(createRequire(import.meta.url).resolve("@openscout/scout/package.json")), "bin", "scout"); } catch { return onPath("scout"); }
}
const findBun = () => (process.env.BUN_INSTALL && exe(path.join(process.env.BUN_INSTALL, "bin", "bun"))) || onPath("bun");

/** Run the scout command with the terminal attached. Returns its exit code. */
function scout(argv) {
  const bin = findScout();
  if (!bin) fail("Scout's CLI didn't come with Scout Chat. Reinstall, or see https://openscout.app/install.md.");
  const bun = findBun();
  const env = { ...process.env, ...(bun ? { PATH: `${path.dirname(bun)}:${process.env.PATH || ""}` } : {}) };
  return spawnSync(bin, argv, { stdio: "inherit", env }).status ?? 1;
}
const rt = await import("../server/runtime.mjs");

async function setup() {
  if (await rt.up()) { console.log("Scout's runtime is up on this host."); return true; }
  if (!findBun()) {
    console.log("Scout's runtime runs on Bun, which isn't on this host.\n" +
      "Install Bun (curl -fsSL https://bun.sh/install | bash), then run this again.");
    return false;
  }
  console.log("Starting Scout: scout setup");
  if (scout(["setup"]) !== 0) { console.log("\nscout setup didn't finish. Run scout doctor to see why."); return false; }
  return rt.up();
}

if (args[0] === "setup" || args[0] === "init") {
  process.exit((await setup()) ? 0 : 1);
}

if (args[0] === "status") {
  const up = await rt.up();
  const k = rt.readKey();
  console.log(`Runtime:  ${up ? `up at ${rt.runtimeUrl()}` : "not answering (scout-chat setup starts it)"}`);
  console.log(`Posting:  ${k.key ? "in your name" : `off: ${k.problem}`}`);
  if (up && findScout()) {
    const r = spawnSync(findScout(), ["integration", "status", "vercel-board"], { encoding: "utf8" });
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
    console.log(`Board:    ${r.status === 0 ? `\n${out}` : /operation not found|unknown/i.test(out)
      ? "this Scout predates Board (Board needs Scout 0.5.4 or newer)" : `not connected (${out.split("\n")[0]})`}`);
  }
  process.exit(0);
}

if (args[0] === "connect") {
  const what = args[1];
  if (!(await rt.up())) fail("Scout's runtime isn't up. Run scout-chat setup first.");
  if (what === "board") {
    const team = opt("--team"), credential = opt("--credential"), url = opt("--url");
    if (!(team || url) || !credential) fail("connect board needs --team <team> (or --url <board url>) and --credential secret_cli:<entry>.");
    if (/^(vcp|vck|vca)_|^[A-Za-z0-9]{24,}$/.test(credential)) fail("--credential names where the token is stored, not the token itself.");
    const argv = ["integration", "connect", "vercel-board", ...(url ? ["--url", url] : ["--team", team]),
      "--credential", credential, ...(opt("--board") ? ["--board", opt("--board")] : [])];
    const code = scout(argv);
    if (code !== 0) console.log("\nIf scout said it doesn't know vercel-board, this Scout is older than Board support: update Scout, then run this again.");
    else console.log("\nBoard rooms show up in Scout Chat as the Board's channels sync.");
    process.exit(code);
  }
  if (what === "slack") {
    const project = opt("--project");
    if (!project) fail("connect slack needs --project <path>: the project whose agent answers in Slack.");
    const code = scout(["integration", "setup", "slack", "--project", path.resolve(project), ...(opt("--agent") ? ["--agent", opt("--agent")] : [])]);
    if (code === 0) {
      console.log(`
Next:
  1. scout integration manifest <operation> --json     the Slack app to create (Socket Mode)
  2. secret set <app-token entry>; secret set <bot-token entry>
  3. scout integration credentials <operation> --if-revision <n> --app-token-key <entry> --bot-token-key <entry> --allowed-users <your Slack user id>
  4. scout integration verify <operation> --if-revision <n>, then start
scout integration status <operation> always says which step is next.
Slack also needs Scout's Slack companion on this host; status says so if it's missing.`);
    }
    process.exit(code);
  }
  fail("connect what? board or slack. See scout-chat --help.");
}

if (args[0] && !args[0].startsWith("-")) fail(`no command ${args[0]}. See scout-chat --help.`);

// start
const { createServer } = await import("../server/serve.mjs");
const want = Number(opt("--port") || process.env.SCOUT_CHAT_PORT || 4802);
if (!Number.isInteger(want) || want <= 0 || want > 65535) fail("--port takes a port number.");
const open = (url) => { if (!args.includes("--no-open") && process.platform === "darwin") execFile("open", [url], () => {}); };

async function ours(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1500) });
    const d = await r.json();
    return r.ok && "canPost" in d;
  } catch { return false; }
}
if (await ours(want)) {
  const url = `http://localhost:${want}`;
  console.log(`Scout Chat is already running at ${url}`);
  open(url);
  process.exit(0);
}

const k = rt.readKey();
if (!(await rt.up())) console.log("Scout's runtime isn't answering yet. Rooms appear once it's up: scout-chat setup starts it.");
if (!k.key) console.log(`Reading only: ${k.problem}.`);

function listen(port, tries = 10) {
  const server = createServer({ port, key: k.key, keyProblem: k.problem });
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE" && tries > 1) return listen(port + 1, tries - 1);
    fail(e.code === "EADDRINUSE" ? `ports ${want} to ${port} are taken. Pass --port.` : e.message);
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://localhost:${port}`;
    console.log(`Scout Chat: ${url}`);
    open(url);
  });
}
listen(want);
