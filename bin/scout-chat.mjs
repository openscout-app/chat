#!/usr/bin/env node
// npx github:openscout-app/chat [--port 4804] [--no-open]       start Scout Chat and open it
// npx github:openscout-app/chat setup                            start Scout's runtime if it isn't up
// npx github:openscout-app/chat connect board --team <team> --credential <ref>
// npx github:openscout-app/chat connect slack --project <path>
// npx github:openscout-app/chat status
import { execFile } from "node:child_process";
import { findBun, integrations, scoutSetup } from "../server/integrations.mjs";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const HELP = `Usage:
  scout-chat [--port <n>] [--no-open]
      Your rooms with your agents, at http://localhost:4804: channels, direct conversations, and
      the rooms Scout keeps for a Vercel Board. What you write goes through Scout's runtime, in your
      name.

  scout-chat setup
      Start Scout's runtime on this host if it isn't up (scout setup). Scout comes with Scout Chat;
      its runtime runs on Bun.

  scout-chat connect board (--team <team ID or slug> | --url <Board API URL>) --credential secret_cli:<entry> [--board <name>]
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

const rt = await import("../server/runtime.mjs");

async function setup() {
  if (await rt.up()) { console.log("Scout's runtime is up on this host."); return true; }
  if (!findBun()) {
    console.log("Scout's runtime runs on Bun, which isn't on this host.\n" +
      "Install Bun (curl -fsSL https://bun.sh/install | bash), then run this again.");
    return false;
  }
  console.log("Starting Scout: scout setup");
  if (scoutSetup() !== 0) { console.log("\nscout setup didn't finish. Run scout doctor to see why."); return false; }
  return rt.up();
}

if (args[0] === "setup" || args[0] === "init") {
  process.exit((await setup()) ? 0 : 1);
}

if (args[0] === "status") {
  const status = await rt.readiness();
  console.log(`Runtime:  ${status.runtime ? `up at ${status.runtime}` : "not answering (scout-chat setup starts it)"}`);
  console.log(`Posting:  ${status.canPost ? "in your name" : `off: ${status.why}`}`);
  const { board, slack } = await integrations.status();
  console.log(`Board:    ${board.message || "available on this host"}`);
  console.log(`Slack:    ${slack.message || "setup available on this host"}`);
  process.exit(0);
}

if (args[0] === "connect") {
  const what = args[1];
  if (what !== "board" && what !== "slack") fail("connect what? board or slack. See scout-chat --help.");
  try {
    const result = await integrations.connect(what, what === "board"
      ? { team: opt("--team"), url: opt("--url"), credential: opt("--credential"), board: opt("--board") }
      : { project: opt("--project"), agent: opt("--agent") });
    console.log(result.message);
    result.steps?.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
    if (result.warning) console.log(result.warning);
    process.exit(0);
  } catch (e) { fail(e.message); }
}

if (args[0] && !args[0].startsWith("-")) fail(`no command ${args[0]}. See scout-chat --help.`);

// Pin the runtime selected at launch so reuse and subsequent API calls agree.
process.env.SCOUT_RUNTIME_URL = rt.runtimeUrl();
const { serve } = await import("../server/serve.mjs");
const { portOptions, start } = await import("../server/local.mjs");
try {
  const result = await start({ ...portOptions(args, process.env.SCOUT_CHAT_PORT), serve });
  console.log(result.reused ? `Scout Chat is already running at ${result.url}` : `Scout Chat: ${result.url}`);
  if (!args.includes("--no-open") && process.platform === "darwin") execFile("open", [result.url], () => {});
  if (result.reused) process.exit(0);
  const status = await rt.readiness();
  if (!status.runtime) console.log("Scout's runtime isn't answering yet. Rooms appear once it's up: scout-chat setup starts it.");
  else if (!status.canPost) console.log(`Posting off: ${status.why}.`);
} catch (e) { fail(e.message); }
