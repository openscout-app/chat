import { execFile, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as rt from "./runtime.mjs";

const exe = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { return null; } };
function onPath(name) {
  for (const d of [...(process.env.PATH || "").split(":"), path.join(os.homedir(), ".bun", "bin"), path.join(os.homedir(), ".local", "bin")]) {
    const p = d && exe(path.join(d, name));
    if (p) return p;
  }
  return null;
}
function findScout() {
  if (process.env.SCOUT_BIN) return exe(process.env.SCOUT_BIN);
  try { return onPath("scout") || exe(path.join(path.dirname(createRequire(import.meta.url).resolve("@openscout/scout/package.json")), "bin", "scout")); }
  catch { return null; }
}
export const findBun = () => (process.env.BUN_INSTALL && exe(path.join(process.env.BUN_INSTALL, "bin", "bun"))) || onPath("bun");
const cliEnv = (runtime) => {
  const bun = findBun();
  return { ...process.env, ...(runtime ? { OPENSCOUT_BROKER_URL: rt.runtimeUrl() } : {}), ...(bun ? { PATH: `${path.dirname(bun)}:${process.env.PATH || ""}` } : {}) };
};
export function scoutSetup() {
  const bin = findScout();
  return bin ? spawnSync(bin, ["setup"], { stdio: "inherit", env: cliEnv(false) }).status ?? 1 : 1;
}

async function runScout(bin, argv) {
  try {
    const { stdout } = await promisify(execFile)(bin, argv, { env: cliEnv(true), timeout: argv[1] === "connect" ? 95_000 : 35_000, maxBuffer: 256 * 1024 });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, stderr: err.stderr || "", stdout: err.stdout || "" };
  }
}

// Core has no read-only companion probe. Check its two known local layouts;
// only Scout's credential check can confirm the running runtime can use the worker.
function hasLocalCompanion(bin) {
  try {
    const root = path.dirname(path.dirname(fs.realpathSync(bin)));
    return ["packages/slack/dist/main.js", "packages/slack/src/main.ts"].some((p) => fs.existsSync(path.join(root, p)));
  } catch { return false; }
}

const runtimeDown = "Scout's runtime isn't answering on this host. Run scout-chat setup.";
const noCli = "Scout's CLI is unavailable on this host. Reinstall Scout, then reopen this panel.";
const upgrade = "This Scout predates Board (Board needs Scout 0.5.4 or newer). Run scout update on this host, then reopen this panel.";
const slackMissing = "Slack companion is unavailable in this host's Scout installation. You can start setup, but install the companion before you add credentials or start the connection.";
const text = (value) => typeof value === "string" ? value.trim() : "";
const tokenShaped = (value) => /^(vcp|vck|vca)_|^[A-Za-z0-9]{24,}$/i.test(value);
const cliOption = (value) => value.startsWith("-") || value === "help";
const entryName = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const tokenError = "Enter the name of a secret_cli entry, not the token itself.";
const inputError = (message) => Object.assign(new Error(message), { status: 400 });

function boardArgs({ team: rawTeam, url: rawUrl, credential: ref, board: rawBoard }) {
  const team = text(rawTeam), url = text(rawUrl), credential = text(ref), board = text(rawBoard);
  const entry = credential.slice("secret_cli:".length);
  if (!credential.startsWith("secret_cli:") || !entryName.test(entry) || tokenShaped(entry)) throw inputError(tokenError);
  if (Boolean(team) === Boolean(url)) throw inputError("Enter a Vercel team ID or slug, or a Board API URL.");
  if (team && (!/^[A-Za-z0-9_-]{1,128}$/.test(team) || tokenShaped(team) || cliOption(team))) throw inputError("Enter a Vercel team ID or slug.");
  if (url) {
    const invalid = "Enter a Vercel Board API URL with a team ID or slug. Do not include credentials.";
    let u, name;
    try { u = new URL(url); name = decodeURIComponent(u.pathname.split("/").filter(Boolean).at(-1)); }
    catch { throw inputError(invalid); }
    const teams = [...u.searchParams];
    if (u.origin !== "https://api.vercel.com" || u.username || u.password || u.hash ||
      !/^\/v\d+\/messageboard\/boards\/[^/]+\/?$/.test(u.pathname) ||
      !/^[^/\u0000-\u001f]{1,64}$/.test(name) || tokenShaped(name) ||
      teams.length !== 1 || !["teamId", "slug"].includes(teams[0][0]) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(teams[0][1]) || tokenShaped(teams[0][1])) throw inputError(invalid);
  }
  if (board && (!/^[^/\u0000-\u001f]{1,64}$/.test(board) || tokenShaped(board) || cliOption(board))) throw inputError("Enter a Board name.");
  return ["integration", "connect", "vercel-board", ...(url ? ["--url", url] : ["--team", team]),
    "--credential", credential, ...(board ? ["--board", board] : [])];
}

function slackArgs(input) {
  const project = text(input.project), agent = text(input.agent);
  if (!project || project.length > 4096 || /[\r\n\0]/.test(project)) throw inputError("Enter the path to a registered Scout project.");
  if (agent && (!/^[A-Za-z0-9._:@-]{1,128}$/.test(agent) || cliOption(agent))) throw inputError("Enter a Scout agent ID.");
  return ["integration", "setup", "slack", "--project", path.resolve(project), ...(agent ? ["--agent", agent] : []), "--json"];
}

const blocked = (message) => ({ available: false, message });
export function createIntegrations({ up = rt.up, find = findScout, run = runScout, hasCompanion = hasLocalCompanion } = {}) {
  async function capability(kind, bin, online) {
    if (!online) return blocked(runtimeDown);
    if (!bin) return blocked(noCli);
    if (kind === "board") {
      const r = await run(bin, ["integration", "status", "vercel-board"]);
      if (!r.ok && /operation not found|unknown (?:command|route)|HTTP 404/i.test(`${r.stdout}${r.stderr}`)) return blocked(upgrade);
      if (!r.ok) return blocked("Scout couldn't check Board support. Run scout integration status vercel-board on this host.");
      return { available: true };
    }
    const r = await run(bin, ["integration", "--help"]);
    if (!r.ok || !r.stdout.includes("integration setup slack")) {
      return blocked("Slack setup is unavailable in this host's Scout installation. Update Scout, then reopen this panel.");
    }
    return { available: true, message: hasCompanion(bin) ? null : slackMissing };
  }

  return {
    async status() {
      const bin = find(), online = await up();
      const [board, slack] = await Promise.all(["board", "slack"].map((kind) => capability(kind, bin, online)));
      return { board, slack };
    },
    async connect(kind, input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw inputError("Send the connection details as a JSON object.");
      const argv = kind === "board" ? boardArgs(input) : slackArgs(input);
      const bin = find();
      const support = await capability(kind, bin, await up());
      if (!support.available) throw Object.assign(new Error(support.message), { status: 409 });
      const r = await run(bin, argv);
      // Do not forward subprocess output. Board passes only a credential
      // reference; Slack returns only the validated operation ID and revision.
      if (!r.ok) throw Object.assign(new Error(kind === "board"
        ? "Scout couldn't connect the Board. Check the team or URL and the secret_cli entry on this host."
        : "Scout couldn't start Slack setup. Check that the project and agent are registered on this host."), { status: 502 });
      if (kind === "board") return { message: "Board connected. Rooms appear as its channels sync." };
      let operation;
      try { operation = JSON.parse(r.stdout).operation; } catch {}
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(operation?.id ?? "") || !Number.isSafeInteger(operation.revision) || operation.revision < 1) {
        throw Object.assign(new Error("Slack setup returned no usable receipt. Check the setup operation in Scout before retrying."), { status: 502 });
      }
      const id = operation.id;
      return {
        message: "Slack setup is ready to continue.",
        warning: support.message,
        steps: [
          `Run scout integration status ${id} to see the current step and revision. Use the latest revision for each command that takes --if-revision.`,
          `Choose the workspace and confirm installation authority with scout integration resume ${id} --if-revision <revision>. Use --workspace <workspace ID> first, then --confirm-workspace-authority.`,
          `Run scout integration manifest ${id} --json. Create a Slack app from the Socket Mode manifest and install it in your workspace. Record its ID with scout integration resume ${id} --if-revision <revision> --app <app ID>.`,
          "Use secret set <entry> to store the app token and bot token under two different entry names.",
          `Run scout integration credentials ${id} --if-revision <revision> --app-token-key <entry> --bot-token-key <entry> --allowed-users <your Slack user ID>.`,
          `Run scout integration start ${id} --if-revision <revision>. Once the app answers a test mention and threaded follow-up, run scout integration verify ${id} --if-revision <revision>.`,
        ],
      };
    },
  };
}
export const integrations = createIntegrations();
