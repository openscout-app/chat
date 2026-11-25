import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync, execFile } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import { randomUUID, createHash, createHmac, randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
const require$1 = createRequire(import.meta.url);
const DEFAULT_WINDOW_MS = 14 * 24 * 36e5;
const PR_URL_RE = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;
function homeDir() {
  return process.env.SCOUT_SESSIONS_HOME || process.env.HOME || os.homedir();
}
function runtimeUrl$1() {
  const explicit = process.env.SCOUT_RUNTIME_URL || process.env.OPENSCOUT_BROKER_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(homeDir(), ".openscout", "config.json"), "utf8"));
    if (cfg?.port) return `http://127.0.0.1:${cfg.port}`;
  } catch {
  }
  return "http://127.0.0.1:43110";
}
function scoutBin() {
  if (process.env.SCOUT_BIN) return process.env.SCOUT_BIN;
  try {
    const pkg = require$1.resolve("@openscout/scout/package.json");
    const candidate = path.join(path.dirname(pkg), "bin", "scout");
    if (fs.existsSync(candidate)) return candidate;
  } catch {
  }
  const which = spawnSync("which", ["scout"], { encoding: "utf8" });
  return which.status === 0 ? which.stdout.trim() : null;
}
function findBun$1() {
  const which = spawnSync("which", ["bun"], { encoding: "utf8" });
  return which.status === 0 ? which.stdout.trim() : null;
}
async function checkRuntime(base = runtimeUrl$1()) {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500), redirect: "error" });
    return res.ok;
  } catch {
    return false;
  }
}
function runScoutSetup(packageName = "@openscout/scout") {
  const bin = scoutBin();
  const bun = findBun$1();
  if (!bin) throw new Error(`Scout CLI not found. Reinstall ${packageName}.`);
  if (!bun) throw new Error("Bun 1.4.4+ is required to run Scout's background runtime (https://bun.sh).");
  const env = { ...process.env, PATH: `${path.dirname(bun)}:${process.env.PATH || ""}` };
  execFileSync(bin, ["setup"], { stdio: "pipe", env, timeout: 3e4 });
}
function isSyntheticPromptRecord(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (/^# AGENTS\.md instructions\b/i.test(trimmed)) return true;
  if (/^<environment_context>/i.test(trimmed) && !trimmed.includes("</environment_context>\n")) return true;
  if (/^The following is a <SYSTEM_MESSAGE>/i.test(trimmed)) return true;
  if (/<command-name>\s*\/(?:clear|compact|login|logout|status|help)\s*<\/command-name>/i.test(trimmed)) return true;
  return false;
}
function stripPromptEnvelope(raw) {
  if (!raw) return "";
  if (isSyntheticPromptRecord(raw)) return "";
  const userReq = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw);
  const picked = userReq ? userReq[1] : raw;
  return picked.replace(/<(ADDITIONAL_METADATA|CONTEXT_SUMMARY|SYSTEM_MESSAGE|INSTRUCTIONS|environment_context|system-reminder|system_reminder|local-command-caveat|recommended_plugins|command-name|command-message|command-args)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ").replace(/<\/?pasted_content\b[^>]*>/gi, " ").replace(/^New (?:broker|runtime) ask from [^\n]+?\.\s*(?:Task:\s*)?/i, "").replace(/<\/?[A-Z_]{4,}>/g, " ").replace(/<truncated \d+ (?:bytes|lines)>/gi, "").replace(/\s+/g, " ").trim();
}
function summarizeHumanTitle(raw, maxLen = 110) {
  if (!raw) return null;
  const cleaned = stripPromptEnvelope(raw).replace(/^#+\s*/, "").replace(/^[>*-\s]+/, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim();
  if (!cleaned) return null;
  const firstSentence = cleaned.split(/\n/)[0]?.trim() || cleaned;
  return firstSentence.length <= maxLen ? firstSentence : `${firstSentence.slice(0, maxLen - 1).trimEnd()}…`;
}
function sniffWorkspaceFromPathHint(candidatePath) {
  if (typeof candidatePath !== "string" || !candidatePath.startsWith("/")) return null;
  const devMatch = /^(\/(?:Users|home)\/[^/]+\/dev\/[^/]+)/.exec(candidatePath);
  if (devMatch?.[1]) return devMatch[1];
  const parts = candidatePath.split("/").filter(Boolean);
  if (parts.length >= 4 && (parts[0] === "Users" || parts[0] === "home") && !parts[2]?.startsWith(".")) {
    return `/${parts.slice(0, 4).join("/")}`;
  }
  return null;
}
function sniffWorkspaceFromText(text2) {
  const activeMatch = /Active Workspaces:\s*\n\s*-\s*([^\r\n<]+)/i.exec(text2);
  if (activeMatch?.[1]?.trim()) return activeMatch[1].trim();
  const cwdMatch = /Command Working Directory:\s*([^\r\n<]+)/i.exec(text2);
  if (cwdMatch?.[1]?.trim()) return cwdMatch[1].trim();
  return null;
}
function walkJsonl(dir, maxDepth, windowMs, filter, out = [], depth = 0) {
  if (depth > maxDepth || !fs.existsSync(dir)) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const now = Date.now();
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonl(full, maxDepth, windowMs, filter, out, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      if (filter && !filter(full, entry.name)) continue;
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs <= windowMs && st.size > 0) {
          out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
        }
      } catch {
      }
    }
  }
  return out;
}
function readSlice(filePath, start, length) {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const clampedStart = Math.max(0, Math.min(start, size));
    const clampedLen = Math.max(0, Math.min(length, size - clampedStart));
    if (clampedLen === 0) return "";
    const buf = Buffer.alloc(clampedLen);
    fs.readSync(fd, buf, 0, clampedLen, clampedStart);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const rec = item;
        if (typeof rec.text === "string") return rec.text;
        if (typeof rec.input_text === "string") return rec.input_text;
        if (typeof rec.output_text === "string") return rec.output_text;
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}
function looksLikeUuid(value) {
  return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
}
function sniffTranscriptMeta(filePath, source, size) {
  let sessionId = path.basename(filePath, ".jsonl");
  let cwd = null;
  let branch = null;
  let model = null;
  let firstPrompt = null;
  let latestPrompt = null;
  if (source === "antigravity") {
    const brainMatch = /brain[\\/]([^\\/]+)[\\/]\.system_generated[\\/]logs[\\/]transcript\.jsonl$/i.exec(filePath) || /brain[\\/]([\da-f-]{36})[\\/]/i.exec(filePath);
    if (brainMatch?.[1]) sessionId = brainMatch[1];
  } else if (source === "kimi") {
    const kimiMatch = /sessions[\\/][^\\/]+[\\/]([^\\/]+)[\\/]agents/i.exec(filePath);
    if (kimiMatch?.[1]) sessionId = kimiMatch[1];
  }
  const fileSize = size ?? (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0);
  const head = readSlice(filePath, 0, 48e3);
  const tail = fileSize > 48e3 ? readSlice(filePath, Math.max(0, fileSize - 48e3), 48e3) : "";
  const lines = [...head.split("\n").slice(0, 30), ...tail ? tail.split("\n").slice(1) : []];
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof obj.cwd === "string" && !cwd) cwd = obj.cwd;
    if (typeof obj.gitBranch === "string" && !branch) branch = obj.gitBranch;
    if (source === "claude") {
      if (typeof obj.sessionId === "string") sessionId = obj.sessionId;
      if (typeof obj.message?.model === "string") model = obj.message.model;
      if (obj.type === "user") {
        const txt = stripPromptEnvelope(flattenContent(obj.message?.content ?? obj.content));
        if (txt) {
          firstPrompt ??= txt;
          latestPrompt = txt;
        }
      }
    } else if (source === "codex") {
      if (obj.type === "session_meta" && obj.payload) {
        if (typeof obj.payload.id === "string") sessionId = obj.payload.id;
        if (typeof obj.payload.cwd === "string" && !cwd) cwd = obj.payload.cwd;
        if (typeof obj.payload.git?.branch === "string" && !branch) branch = obj.payload.git.branch;
      }
      if (obj.type === "turn_context" && typeof obj.payload?.model === "string") model = obj.payload.model;
      if (obj.type === "response_item" && obj.payload?.role === "user") {
        const txt = stripPromptEnvelope(flattenContent(obj.payload.content));
        if (txt) {
          firstPrompt ??= txt;
          latestPrompt = txt;
        }
      } else if (obj.type === "event_msg" && obj.payload?.type === "user_message") {
        const txt = stripPromptEnvelope(String(obj.payload.message ?? obj.payload.text ?? ""));
        if (txt) {
          firstPrompt ??= txt;
          latestPrompt = txt;
        }
      }
    } else if (source === "antigravity") {
      const step = obj.step || obj;
      const type = String(step.type || "");
      if (typeof step.metadata?.generatorModel === "string") model = step.metadata.generatorModel;
      if (typeof step.model === "string" && !model) model = step.model;
      const ws = step.userInput?.activeUserState?.activeDocument?.workspaceUri;
      if (typeof ws === "string" && ws.startsWith("file://") && !cwd) {
        cwd = decodeURIComponent(ws.slice("file://".length));
      }
      if (!cwd && typeof step.content === "string") {
        cwd = sniffWorkspaceFromText(step.content);
      }
      const rawCalls = step.plannerResponse?.toolCalls || step.tool_calls || [];
      if (!cwd && Array.isArray(rawCalls)) {
        for (const call of rawCalls) {
          let args = call?.args || call?.arguments || {};
          if (typeof call?.argumentsJson === "string") {
            try {
              args = JSON.parse(call.argumentsJson);
            } catch {
            }
          }
          cwd = sniffWorkspaceFromPathHint(args?.Path || args?.TargetFile);
          if (cwd) break;
        }
      }
      if (type === "USER_INPUT" || type.endsWith("_USER_INPUT")) {
        const rawPrompt = String(step.userInput?.userResponse ?? step.content ?? "");
        if (!cwd) cwd = sniffWorkspaceFromText(rawPrompt);
        const txt = stripPromptEnvelope(rawPrompt);
        if (txt) {
          firstPrompt ??= txt;
          latestPrompt = txt;
        }
      }
    } else if (source === "kimi") {
      if (obj.type === "turn.prompt") {
        const txt = stripPromptEnvelope(flattenContent(obj.input ?? obj.content));
        if (txt) {
          firstPrompt ??= txt;
          latestPrompt = txt;
        }
      }
    }
  }
  let project = "session";
  if (cwd) {
    project = path.basename(cwd);
  } else if (source === "claude") {
    const dirName = path.basename(path.dirname(filePath));
    project = dirName.replace(/^-/, "").split("-").pop() || "claude";
  } else if (source === "kimi") {
    const wdMatch = /sessions[\\/]wd_([^\\/]+)[\\/]/i.exec(filePath);
    project = wdMatch?.[1] || "kimi";
  } else if (!looksLikeUuid(sessionId)) {
    project = sessionId;
  } else {
    project = source === "antigravity" ? "Antigravity" : source;
  }
  const title = summarizeHumanTitle(latestPrompt || firstPrompt);
  return { sessionId, cwd, project, branch, model, title };
}
const transcriptDiscoveryCache = /* @__PURE__ */ new Map();
function discoverLocalTranscripts(options = {}) {
  const home = homeDir();
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxPerHarness = options.maxPerHarness ?? 40;
  const filterHarness = options.harness || "";
  const cacheKey = `${home}|${windowMs}|${maxPerHarness}|${filterHarness}|${process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT || ""}|${process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT || ""}|${process.env.OPENSCOUT_TAIL_ANTIGRAVITY_BRAIN_ROOT || ""}|${process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT || ""}`;
  const cached = !options.bypassCache ? transcriptDiscoveryCache.get(cacheKey) : void 0;
  if (cached && Date.now() - cached.at < 2500) {
    return cached.items;
  }
  const claudeRoot = process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT || path.join(home, ".claude", "projects");
  const codexRoot = process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT || path.join(home, ".codex", "sessions");
  const kimiHome = process.env.KIMI_CODE_HOME?.trim() || path.join(home, ".kimi-code");
  const kimiRoot = process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT || path.join(kimiHome, "sessions");
  const agyBrainOverride = process.env.OPENSCOUT_TAIL_ANTIGRAVITY_BRAIN_ROOT;
  const brainFilter = (full, name) => name === "transcript.jsonl" && full.includes(`${path.sep}.system_generated${path.sep}logs${path.sep}`);
  const sources = [
    { source: "claude", files: walkJsonl(claudeRoot, 3, windowMs) },
    {
      source: "codex",
      files: [
        ...walkJsonl(codexRoot, 4, windowMs),
        ...process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT ? [] : walkJsonl(path.join(home, ".openai-codex", "sessions"), 4, windowMs)
      ]
    },
    {
      source: "antigravity",
      files: [
        ...agyBrainOverride ? walkJsonl(agyBrainOverride, 4, windowMs, brainFilter) : [
          ...walkJsonl(path.join(home, ".gemini", "antigravity-cli", "brain"), 4, windowMs, brainFilter),
          ...walkJsonl(path.join(home, ".gemini", "antigravity", "brain"), 4, windowMs, brainFilter),
          ...walkJsonl(path.join(home, ".gemini", "antigravity-ide", "brain"), 4, windowMs, brainFilter)
        ],
        ...walkJsonl(path.join(home, ".gemini", "antigravity", "conversations"), 2, windowMs)
      ]
    },
    {
      source: "kimi",
      files: [
        ...walkJsonl(kimiRoot, 5, windowMs, (_full, name) => name === "wire.jsonl"),
        ...process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT ? [] : walkJsonl(path.join(home, ".kimi", "sessions"), 5, windowMs)
      ]
    }
  ];
  const seenPaths = /* @__PURE__ */ new Set();
  const transcripts = [];
  for (const group of sources) {
    if (filterHarness && group.source !== filterHarness) continue;
    const recent = group.files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxPerHarness);
    for (const item of recent) {
      if (seenPaths.has(item.path)) continue;
      seenPaths.add(item.path);
      try {
        const meta = sniffTranscriptMeta(item.path, group.source, item.size);
        transcripts.push({
          source: group.source,
          sessionId: meta.sessionId,
          project: meta.project,
          cwd: meta.cwd,
          branch: meta.branch,
          model: meta.model,
          title: meta.title,
          transcriptPath: item.path,
          mtimeMs: Math.floor(item.mtimeMs),
          size: item.size
        });
      } catch {
      }
    }
  }
  const sorted = transcripts.sort((a, b) => b.mtimeMs - a.mtimeMs);
  transcriptDiscoveryCache.set(cacheKey, { at: Date.now(), items: sorted });
  return sorted;
}
function collectPrs(text2, prsMap, fallbackTitle) {
  if (!text2 || typeof text2 !== "string") return;
  const mergedHint = /\bmerged\b/i.test(text2);
  for (const match of text2.matchAll(PR_URL_RE)) {
    const [, owner, repo, num] = match;
    const key = `${repo}#${num}`;
    const prev = prsMap.get(key);
    prsMap.set(key, {
      key,
      label: key,
      number: Number(num),
      url: `https://github.com/${owner}/${repo}/pull/${num}`,
      title: prev?.title || fallbackTitle || key,
      state: prev?.state === "merged" || mergedHint ? "merged" : "open"
    });
  }
}
function recordTouchedPath(rawPath, cwd, set) {
  if (!rawPath || typeof rawPath !== "string") return;
  const cleaned = rawPath.trim();
  if (!cleaned) return;
  if (cwd && cleaned.startsWith(cwd)) {
    const rel = cleaned.slice(cwd.length).replace(/^[\\/]+/, "");
    if (rel) {
      set.add(rel);
      return;
    }
  }
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  set.add(parts.slice(-3).join("/") || cleaned);
}
function scanLocalFeedSessions(options = {}) {
  const discovered = discoverLocalTranscripts({ maxPerHarness: options.maxPerHarness ?? 15 });
  const items = [];
  for (const entry of discovered) {
    try {
      const raw = readSlice(entry.transcriptPath, Math.max(0, entry.size - 65536), 65536);
      const lines = raw.split("\n").filter(Boolean);
      let prompt = entry.title;
      let reply = null;
      let branch = entry.branch;
      const touched = /* @__PURE__ */ new Set();
      const prsMap = /* @__PURE__ */ new Map();
      for (const line of lines) {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.source === "claude") {
          if (obj.gitBranch && !branch) branch = obj.gitBranch;
          if (obj.type === "user") {
            const txt = stripPromptEnvelope(flattenContent(obj.message?.content ?? obj.content));
            if (txt) prompt = txt;
            if (Array.isArray(obj.message?.content)) {
              for (const b of obj.message.content) {
                if (b?.type === "tool_result" && typeof b.content === "string") collectPrs(b.content, prsMap, null);
              }
            }
          } else if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
            const text2 = obj.message.content.filter((b) => b?.type === "text" && b.text).map((b) => b.text).join("\n").trim();
            if (text2) {
              reply = text2;
              collectPrs(text2, prsMap, null);
            }
            for (const b of obj.message.content) {
              if (b?.type === "tool_use" && b.input && (b.name === "Edit" || b.name === "Write" || b.name === "MultiEdit")) {
                recordTouchedPath(b.input.file_path || b.input.path, entry.cwd, touched);
              }
            }
          }
        } else if (entry.source === "codex") {
          if (obj.type === "session_meta" && obj.payload?.git?.branch) branch = obj.payload.git.branch;
          if (obj.type === "response_item" && obj.payload?.role === "user") {
            const txt = stripPromptEnvelope(flattenContent(obj.payload.content));
            if (txt) prompt = txt;
          } else if (obj.type === "response_item" && obj.payload?.role === "assistant") {
            const txt = flattenContent(obj.payload.content).trim();
            if (txt) {
              reply = txt;
              collectPrs(txt, prsMap, null);
            }
          } else if (obj.type === "response_item" && (obj.payload?.type === "custom_tool_call" || obj.payload?.type === "function_call")) {
            const patchText = typeof obj.payload?.input === "string" ? obj.payload.input : obj.payload?.arguments || "";
            for (const pm of String(patchText).matchAll(/\*\*\* (?:Update|Add) File:\s*([^\r\n]+)/g)) {
              recordTouchedPath(pm[1], entry.cwd, touched);
            }
          } else if (obj.type === "response_item" && obj.payload?.type === "function_call_output") {
            collectPrs(obj.payload.output, prsMap, null);
          }
        } else if (entry.source === "antigravity") {
          const step = obj.step || obj;
          const type = String(step.type || "");
          if (type.endsWith("USER_INPUT")) {
            const txt = stripPromptEnvelope(String(step.userInput?.userResponse ?? step.content ?? ""));
            if (txt) prompt = txt;
          } else if (type.endsWith("PLANNER_RESPONSE")) {
            const text2 = String(step.plannerResponse?.modifiedResponse ?? step.plannerResponse?.response ?? step.content ?? "").trim();
            if (text2) {
              reply = text2;
              collectPrs(text2, prsMap, null);
            }
            for (const tc of step.plannerResponse?.toolCalls || []) {
              if (tc.name === "edit_file" || tc.name === "write_file") {
                let args = tc.argumentsJson;
                if (typeof args === "string") {
                  try {
                    args = JSON.parse(args);
                  } catch {
                    args = null;
                  }
                }
                if (args?.Path) recordTouchedPath(args.Path, entry.cwd, touched);
              }
            }
          }
          if (step.runCommand?.combinedOutput?.full) {
            collectPrs(step.runCommand.combinedOutput.full, prsMap, null);
          }
        } else if (entry.source === "kimi") {
          if (obj.type === "turn.prompt") {
            const txt = stripPromptEnvelope(flattenContent(obj.input ?? obj.content));
            if (txt) prompt = txt;
          } else if (obj.type === "context.append_loop_event" && obj.event?.part?.text) {
            reply = obj.event.part.text;
            collectPrs(reply, prsMap, null);
          }
        }
      }
      if (!reply && !prompt) continue;
      const cleanReply = (reply || prompt || "").trim();
      const firstLine = cleanReply.split("\n").find((l) => l.trim().length > 0)?.replace(/^#+\s*/, "").trim() || "Completed session turn";
      const headline = firstLine.slice(0, 140);
      const prs = [...prsMap.values()].map((pr) => ({
        ...pr,
        title: pr.title === pr.key ? headline : pr.title
      }));
      items.push({
        id: `local:session:${entry.source}:${entry.sessionId}`,
        sessionId: entry.sessionId,
        source: entry.source,
        project: entry.project.startsWith(".") || entry.project === "logs" || entry.project === "main" ? null : entry.project,
        cwd: entry.cwd,
        branch,
        title: headline,
        asked: prompt ? prompt.trim().slice(0, 280) : null,
        body: cleanReply.slice(0, 2400),
        filesTouched: [...touched],
        prs,
        at: entry.mtimeMs,
        transcriptPath: entry.transcriptPath
      });
    } catch {
    }
  }
  return items.sort((a, b) => b.at - a.at).slice(0, options.limit ?? 30);
}
function parseSessionObserve(transcript) {
  const content = fs.readFileSync(transcript.transcriptPath, "utf8");
  const allLines = content.split("\n");
  const startIdx = Math.max(0, allLines.length - 1600);
  const events = [];
  let model = transcript.model ?? null;
  let branch = transcript.branch ?? null;
  let cwd = transcript.cwd ?? null;
  let seq = 0;
  for (let i = startIdx; i < allLines.length; i++) {
    const line = allLines[i];
    if (!line?.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(obj.timestamp || obj.created_at || obj.step?.metadata?.createdAt || "") || transcript.mtimeMs;
    if (transcript.source === "claude") {
      if (obj.cwd && !cwd) cwd = obj.cwd;
      if (obj.gitBranch && !branch) branch = obj.gitBranch;
      if (obj.message?.model) model = obj.message.model;
      if (obj.type === "user") {
        const text2 = stripPromptEnvelope(flattenContent(obj.message?.content ?? obj.content));
        if (text2) events.push({ id: `ev-${++seq}`, kind: "prompt", text: text2, ts, recordIndex: i });
      } else if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (block?.type === "text" && block.text) {
            events.push({ id: `ev-${++seq}`, kind: "message", text: block.text, ts, recordIndex: i });
          } else if (block?.type === "tool_use") {
            const pathVal = block.input?.file_path || block.input?.path || void 0;
            const arg = block.input?.command || pathVal || block.input?.pattern || "";
            events.push({
              id: `ev-${++seq}`,
              kind: "tool",
              tool: block.name || "tool",
              arg: String(arg),
              ...pathVal ? { path: String(pathVal) } : {},
              text: `${block.name || "tool"} ${arg}`.trim(),
              ts,
              recordIndex: i
            });
          }
        }
      }
    } else if (transcript.source === "codex") {
      if (obj.type === "session_meta") {
        if (obj.payload?.cwd && !cwd) cwd = obj.payload.cwd;
        if (obj.payload?.git?.branch && !branch) branch = obj.payload.git.branch;
      }
      if (obj.type === "turn_context" && obj.payload?.model) model = obj.payload.model;
      if (obj.type === "response_item" && obj.payload?.role === "user") {
        const text2 = stripPromptEnvelope(flattenContent(obj.payload.content));
        if (text2) events.push({ id: `ev-${++seq}`, kind: "prompt", text: text2, ts, recordIndex: i });
      } else if (obj.type === "response_item" && obj.payload?.role === "assistant") {
        const text2 = flattenContent(obj.payload.content).trim();
        if (text2) events.push({ id: `ev-${++seq}`, kind: "message", text: text2, ts, recordIndex: i });
      } else if (obj.type === "response_item" && (obj.payload?.type === "function_call" || obj.payload?.type === "local_shell_call")) {
        let arg = String(obj.payload.arguments || obj.payload.command || "");
        try {
          const parsed = JSON.parse(arg);
          arg = parsed.cmd || parsed.command || (Array.isArray(parsed.command) ? parsed.command.join(" ") : arg);
        } catch {
        }
        events.push({
          id: `ev-${++seq}`,
          kind: "tool",
          tool: obj.payload.name || "shell",
          arg: String(arg).slice(0, 220),
          text: `${obj.payload.name || "shell"} ${String(arg).slice(0, 220)}`.trim(),
          ts,
          recordIndex: i
        });
      }
    } else if (transcript.source === "antigravity") {
      const step = obj.step || obj;
      const type = String(step.type || "");
      if (step.metadata?.generatorModel) model = step.metadata.generatorModel;
      if (typeof step.model === "string") model = step.model;
      if (type === "USER_INPUT" || type.endsWith("_USER_INPUT")) {
        const text2 = stripPromptEnvelope(String(step.userInput?.userResponse ?? step.content ?? ""));
        if (text2) events.push({ id: `ev-${++seq}`, kind: "prompt", text: text2, ts, recordIndex: i });
      } else if (type === "PLANNER_RESPONSE" || type.endsWith("_PLANNER_RESPONSE")) {
        const pr = step.plannerResponse;
        const calls = pr?.toolCalls || step.tool_calls || [];
        for (const call of calls) {
          let args = {};
          try {
            args = typeof call.argumentsJson === "string" ? JSON.parse(call.argumentsJson) : call.arguments || call.args || {};
          } catch {
          }
          const toolName = call.name || call.tool_name || "tool";
          const pathVal = args.Path || args.TargetFile || null;
          if (!cwd && pathVal) cwd = sniffWorkspaceFromPathHint(pathVal);
          const arg = args.CommandLine || pathVal || args.query || args.toolSummary || toolName;
          events.push({
            id: `ev-${++seq}`,
            kind: "tool",
            tool: toolName,
            arg: String(arg),
            ...pathVal ? { path: String(pathVal) } : {},
            text: `${toolName} ${arg}`.trim(),
            ts,
            recordIndex: i
          });
        }
        const reply = pr?.modifiedResponse || pr?.response || (typeof step.content === "string" ? step.content : "");
        if (reply) events.push({ id: `ev-${++seq}`, kind: "message", text: reply, ts, recordIndex: i });
      }
    } else if (transcript.source === "kimi") {
      if (obj.type === "turn.prompt") {
        const text2 = stripPromptEnvelope(flattenContent(obj.input ?? obj.content));
        if (text2) events.push({ id: `ev-${++seq}`, kind: "prompt", text: text2, ts, recordIndex: i });
      } else if (obj.type === "context.append_loop_event") {
        const ev = obj.event;
        if (ev?.type === "tool.call") {
          const arg = typeof ev.args === "string" ? ev.args : JSON.stringify(ev.args ?? ev.input ?? {}).slice(0, 180);
          events.push({ id: `ev-${++seq}`, kind: "tool", tool: ev.name || "tool", arg, text: `${ev.name || "tool"} ${arg}`.trim(), ts, recordIndex: i });
        } else if (ev?.part?.text) {
          events.push({ id: `ev-${++seq}`, kind: "message", text: String(ev.part.text), ts, recordIndex: i });
        }
      }
    }
  }
  return {
    live: Date.now() - transcript.mtimeMs < 6e4,
    events,
    files: [],
    metadata: {
      session: {
        adapterType: transcript.source,
        cwd,
        externalSessionId: transcript.sessionId || path.basename(transcript.transcriptPath, ".jsonl"),
        ...model ? { model } : {},
        ...branch ? { branch } : {},
        ...transcript.title ? { title: transcript.title } : {}
      }
    }
  };
}
async function resolveSessionObserve(requestedId) {
  const cleaned = requestedId.replace(/^session:[^:]+:/, "");
  let hit = discoverLocalTranscripts({ maxPerHarness: 80 }).find(
    (t) => t.sessionId === cleaned || t.transcriptPath === cleaned || t.transcriptPath.includes(cleaned)
  ) ?? discoverLocalTranscripts({ maxPerHarness: 80, bypassCache: true }).find(
    (t) => t.sessionId === cleaned || t.transcriptPath === cleaned || t.transcriptPath.includes(cleaned)
  );
  if (!hit) {
    const base = runtimeUrl$1();
    if (await checkRuntime(base)) {
      try {
        const res = await fetch(`${base}/v1/tail/discover`, {
          signal: AbortSignal.timeout(2500),
          redirect: "error"
        });
        if (res.ok) {
          const snap = await res.json();
          const rtHit = (snap?.transcripts || []).find(
            (t) => t.sessionId === cleaned || typeof t.transcriptPath === "string" && t.transcriptPath.includes(cleaned)
          );
          if (rtHit && typeof rtHit.transcriptPath === "string" && fs.existsSync(rtHit.transcriptPath)) {
            const st = fs.statSync(rtHit.transcriptPath);
            const meta = sniffTranscriptMeta(rtHit.transcriptPath, rtHit.source || "claude", st.size);
            hit = {
              source: rtHit.source || "claude",
              sessionId: rtHit.sessionId || meta.sessionId,
              project: rtHit.project || meta.project,
              cwd: rtHit.cwd || meta.cwd,
              branch: meta.branch,
              model: meta.model,
              title: meta.title,
              transcriptPath: rtHit.transcriptPath,
              mtimeMs: Math.floor(st.mtimeMs),
              size: st.size
            };
          }
        }
      } catch {
      }
    }
  }
  if (!hit || !fs.existsSync(hit.transcriptPath)) return null;
  const data = parseSessionObserve(hit);
  return {
    kind: "observe",
    refId: hit.sessionId,
    observe: {
      kind: "history",
      refId: hit.sessionId,
      sessionId: hit.sessionId,
      source: hit.source,
      project: hit.project,
      fidelity: "timestamped",
      updatedAt: hit.mtimeMs,
      data
    }
  };
}
function readTranscriptContextWindow(params) {
  const home = homeDir();
  let filePath = null;
  if (params.source) {
    const candidate = params.source.startsWith("~/") ? path.join(home, params.source.slice(2)) : params.source;
    if (fs.existsSync(candidate) && candidate.endsWith(".jsonl")) filePath = candidate;
  }
  const local = discoverLocalTranscripts({ maxPerHarness: 80 });
  const hit = local.find(
    (t) => filePath && t.transcriptPath === filePath || params.sessionId && (t.sessionId === params.sessionId || t.transcriptPath.includes(params.sessionId))
  );
  if (!hit && !filePath) return null;
  const targetPath = hit?.transcriptPath ?? filePath;
  const harness = hit?.source ?? (targetPath.includes(".claude") ? "claude" : targetPath.includes("antigravity") ? "antigravity" : targetPath.includes("kimi") ? "kimi" : "codex");
  const st = fs.statSync(targetPath);
  const meta = hit ?? { ...sniffTranscriptMeta(targetPath, harness, st.size), source: harness, transcriptPath: targetPath, mtimeMs: st.mtimeMs, size: st.size };
  const parsed = parseSessionObserve(meta);
  const center = params.centerRecord ?? -1;
  const radius = params.radius ?? 3;
  let matchPos = parsed.events.findIndex((e) => e.recordIndex === center);
  if (matchPos < 0 && center >= 0) {
    matchPos = parsed.events.reduce((best, ev, idx) => {
      if (ev.recordIndex == null) return best;
      if (best < 0) return idx;
      const prevDiff = Math.abs((parsed.events[best]?.recordIndex ?? 0) - center);
      return Math.abs(ev.recordIndex - center) < prevDiff ? idx : best;
    }, -1);
  }
  const sliceStart = matchPos >= 0 ? Math.max(0, matchPos - radius) : Math.max(0, parsed.events.length - (radius * 2 + 1));
  const sliceEnd = matchPos >= 0 ? Math.min(parsed.events.length, matchPos + radius + 1) : parsed.events.length;
  const turns = parsed.events.slice(sliceStart, sliceEnd).map((ev, idx) => ({
    index: ev.recordIndex ?? sliceStart + idx,
    role: ev.kind === "prompt" ? "prompt" : ev.kind === "tool" ? "tool" : "reply",
    label: ev.kind === "prompt" ? "You" : ev.kind === "tool" ? ev.tool || "Tool" : "Agent",
    text: ev.kind === "tool" ? ev.arg || ev.text : ev.text,
    matched: matchPos >= 0 ? sliceStart + idx === matchPos : false
  }));
  return {
    sessionId: meta.sessionId,
    project: meta.project,
    harness: meta.source,
    title: meta.title,
    turns
  };
}
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
function isLoopbackHost(req) {
  return LOCAL_HOST.test(req.headers.host || "");
}
function isLocalRequest(req) {
  const host = req.headers.host || "";
  if (!isLoopbackHost(req)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
function sendJson(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(data));
}
async function readJsonBody(req, maxBytes = 16384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) throw new Error("Request body is too large.");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed;
}
function createScoutThinHttpHandler(options) {
  const title = options.product === "Scout" ? "Scout" : `Scout ${options.product}`;
  return async function handleThinApi(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = url.pathname;
    if (!pathname.startsWith("/api/") && !pathname.startsWith("/v1/")) return false;
    if (!isLocalRequest(req)) {
      sendJson(res, 403, { error: `Open ${title} on this host.` });
      return true;
    }
    const runtimeBase = runtimeUrl$1();
    if (req.method === "GET" && pathname === "/api/identity") {
      sendJson(res, 200, { app: options.packageName, product: options.product });
      return true;
    }
    if (options.apiHandler) {
      const handled = await options.apiHandler(req, res, { url, pathname, runtimeBase });
      if (handled) return true;
    }
    if (req.method === "GET" && pathname === "/api/status") {
      const runtimeUp = await checkRuntime(runtimeBase);
      const extra = options.getStatus ? await options.getStatus({ runtimeUp, runtimeUrl: runtimeBase }) : {};
      sendJson(res, 200, { runtimeUp, runtimeUrl: runtimeBase, ...extra });
      return true;
    }
    if (req.method === "POST" && pathname === "/api/setup") {
      try {
        runScoutSetup(options.packageName);
        sendJson(res, 200, { ok: true, runtimeUp: await checkRuntime(runtimeBase) });
      } catch (err) {
        sendJson(res, 503, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    if (req.method === "GET" && (pathname === "/v1/events/stream" || pathname === "/v1/tail/events")) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive"
      });
      res.write(": connected\n\n");
      const keepAlive = setInterval(() => res.write(": ping\n\n"), 2e4);
      req.on("close", () => clearInterval(keepAlive));
      return true;
    }
    if (req.method === "GET" && pathname === "/api/recent-sessions") {
      const limit = Math.min(24, Math.max(1, Number(url.searchParams.get("limit") ?? 8)));
      const sessions = discoverLocalTranscripts({ maxPerHarness: 15 }).slice(0, limit).map((item) => ({
        sessionId: item.sessionId,
        harness: item.source,
        project: item.project,
        branch: item.branch,
        model: item.model,
        title: item.title,
        updatedAt: item.mtimeMs
      }));
      sendJson(res, 200, { sessions });
      return true;
    }
    if (req.method === "POST" && pathname === "/api/session-context") {
      try {
        const body = await readJsonBody(req);
        const context = readTranscriptContextWindow(body);
        if (!context) {
          sendJson(res, 404, { error: "Session transcript not found." });
          return true;
        }
        sendJson(res, 200, context);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    const refMatch = /^\/api\/session-ref\/(.+)$/.exec(pathname);
    if (req.method === "GET" && refMatch?.[1]) {
      const resolved = await resolveSessionObserve(decodeURIComponent(refMatch[1]));
      if (!resolved) {
        sendJson(res, 404, { error: "Session transcript not found." });
        return true;
      }
      sendJson(res, 200, resolved);
      return true;
    }
    if (req.method === "GET" && pathname === "/api/messages") {
      const conversationId = url.searchParams.get("conversationId") || "";
      if (conversationId && await checkRuntime(runtimeBase)) {
        try {
          const upstream = await fetch(`${runtimeBase}/v1/messages?conversationId=${encodeURIComponent(conversationId)}&limit=50`, {
            signal: AbortSignal.timeout(3e3),
            redirect: "error"
          });
          if (upstream.ok) {
            const data = await upstream.json();
            sendJson(res, 200, Array.isArray(data) ? data : data.messages || []);
            return true;
          }
        } catch {
        }
      }
      sendJson(res, 200, []);
      return true;
    }
    sendJson(res, 404, { error: `Unknown ${title} API route.` });
    return true;
  };
}
function runtimeUrl() {
  const env = process.env.SCOUT_RUNTIME_URL || process.env.OPENSCOUT_BROKER_URL;
  if (env) return env.replace(/\/+$/, "");
  try {
    const home = process.env.OPENSCOUT_HOME || path.join(os.homedir(), ".openscout");
    const c = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    const port = Number(c?.ports?.broker);
    if (Number.isInteger(port) && port > 0) {
      const host = !c.host || c.host === "0.0.0.0" || c.host === "::" ? "127.0.0.1" : c.host;
      return `http://${host}:${port}`;
    }
  } catch {
  }
  return "http://127.0.0.1:43110";
}
function keyFile(env = process.env) {
  if (env.OPENSCOUT_ATTRIBUTION_KEY_FILE?.trim()) return env.OPENSCOUT_ATTRIBUTION_KEY_FILE.trim();
  const support = env.OPENSCOUT_SUPPORT_DIRECTORY?.trim() || (process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "OpenScout") : path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "openscout"));
  return path.join(support, "runtime", "operator-attribution.key");
}
function readKey(file = keyFile()) {
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > 256 || (st.mode & 63) !== 0 || process.getuid && st.uid !== process.getuid())
        return { problem: "the operator key must be a file only you can read" };
      const key = fs.readFileSync(fd, "utf8").trim();
      return /^[a-f0-9]{64}$/.test(key) ? { key } : { problem: "the operator key isn't in the expected form" };
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return { problem: e.code === "ENOENT" ? "there's no operator key on this host yet. Scout 0.5.4 or newer makes one when you run scout setup" : "the operator key couldn't be read" };
  }
}
function sign(key, { method, path: p, body = "", destinationKeyId, ts = Date.now(), nonce = randomBytes(16).toString("base64") }) {
  const payload = [
    "local-admin:v1",
    method.toUpperCase(),
    p,
    createHash("sha256").update(body).digest("hex"),
    destinationKeyId,
    String(ts),
    nonce
  ].join("\n");
  return {
    "x-openscout-local-admin": createHmac("sha256", Buffer.from(key, "hex")).update(payload).digest("hex"),
    "x-openscout-local-admin-ts": String(ts),
    "x-openscout-local-admin-nonce": nonce
  };
}
async function get(p, ms = 8e3, headers) {
  const res = await fetch(`${runtimeUrl()}${p}`, { headers, redirect: "error", signal: AbortSignal.timeout(ms) });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`${p}: ${res.status}`);
  }
  return res.json();
}
async function nodeInfo() {
  const n = await get("/v1/node", 2500);
  if (typeof n?.id !== "string" || !n.id) throw new Error("the runtime didn't name its node");
  return { id: n.id, name: n.name || n.hostName || "", hostName: n.hostName, keyId: n.card?.keyId };
}
async function up() {
  try {
    await nodeInfo();
    return true;
  } catch {
    return false;
  }
}
async function readiness({ key, problem } = readKey()) {
  const p = "/v1/conversation-projection?limit=1";
  const base = runtimeUrl();
  const [node, readable] = await Promise.all([
    nodeInfo().catch(() => null),
    get(p, 2500).then((d) => Array.isArray(d?.items), () => false)
  ]);
  let why = !node ? "Scout's runtime isn't answering" : !readable ? "the runtime isn't serving rooms" : !key ? problem || "posting isn't set up" : !node.keyId ? "the runtime didn't name its signing key" : null;
  if (!why) {
    try {
      const [signed, rejectsInvalidProof] = await Promise.all([
        get(p, 2500, sign(key, { method: "GET", path: p, destinationKeyId: node.keyId })),
        // A runtime that ignores proof headers can answer the signed read without authenticating it.
        fetch(base + p, { headers: { "x-openscout-local-admin": "invalid" }, redirect: "error", signal: AbortSignal.timeout(2500) }).then(async (r) => r.status === 401 ? (await r.json())?.error === "invalid_local_admin_proof" : (await r.body?.cancel(), false))
      ]);
      if (!Array.isArray(signed?.items) || !rejectsInvalidProof) throw new Error();
    } catch {
      why = "the runtime didn't verify the operator key";
    }
  }
  return {
    listening: true,
    readable,
    writable: !why,
    runtime: node ? base : null,
    host: node?.name || null,
    nodeId: node?.id || null,
    canPost: !why,
    why
  };
}
const ROOM_KINDS = /* @__PURE__ */ new Set(["channel", "direct", "group_direct"]);
async function rooms(limit = 200) {
  const d = await get(`/v1/conversation-projection?limit=${limit}`);
  return d.items.filter((i) => ROOM_KINDS.has(i.kind) && i.conversationId).map((i) => ({
    id: i.conversationId,
    kind: i.kind === "channel" ? "channel" : "direct",
    title: (i.title || i.agentName || i.conversationId).replace(/\s*\(Vercel Board\)$/, ""),
    board: /\(Vercel Board\)$/.test(i.title || ""),
    askTarget: i.kind !== "channel" && i.agentId ? { id: i.agentId, name: i.agentName || i.agentId } : null,
    agentId: i.agentId || null,
    agentName: i.agentName || null,
    preview: i.preview || "",
    lastAt: i.lastMessageAt || i.lastActivityAt || 0,
    unread: i.unreadCount || 0,
    state: i.activityState || null
  }));
}
function hasReceiveRoute(endpoint, { pairingSessions, sameHost: sameHost2, now }) {
  const { state, transport, metadata } = endpoint;
  const busy = ["active", "working", "waiting"].includes(state);
  if (metadata?.externalSession === true && metadata.t3Session !== true) {
    if (transport === "mcp_poll") return busy || ["registered", "online", "idle"].includes(state);
    if (transport === "http" || transport === "devin_cloud_cli") return state === "online" || state === "idle";
  }
  if (transport === "claude_channel" && state === "idle") {
    const age = now - metadata?.lastSeenAt;
    return age >= 0 && age < 45e3;
  }
  if (transport === "pairing_bridge" && (state === "idle" || busy))
    return pairingSessions.has(endpoint.sessionId);
  if (transport === "ghostty" && sameHost2 && (state === "idle" || busy) && metadata?.attachedLive === true && metadata.ghosttyTerminalId) {
    const pid = metadata.livePid;
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
async function askTargets() {
  const [snapshot, { endpoints }, node] = await Promise.all([
    get("/v1/snapshot?scope=agents"),
    get("/v1/endpoints"),
    nodeInfo()
  ]);
  const byAgent = /* @__PURE__ */ new Map();
  for (const e of endpoints) {
    if (e.metadata?.staleLocalRegistration || e.state === "offline" && e.metadata?.replacedByAgentId) continue;
    if (!byAgent.has(e.agentId)) byAgent.set(e.agentId, []);
    byAgent.get(e.agentId).push(e);
  }
  const agents = Object.values(snapshot.agents).filter((a) => a.kind === "agent" && a.id && a.authorityNodeId === node.id && !a.metadata?.retiredFromFleet && !a.metadata?.staleLocalRegistration && byAgent.has(a.id) && a.capabilities?.some((c) => c === "chat" || c === "invoke"));
  const pairingSessions = /* @__PURE__ */ new Set();
  let pairingError;
  if (agents.some((a) => byAgent.get(a.id).some((e) => e.transport === "pairing_bridge"))) {
    try {
      for (const session of await get("/v1/pairing/sessions"))
        if (session.externalSessionId && ["idle", "active"].includes(session.status)) pairingSessions.add(session.externalSessionId);
    } catch (error) {
      pairingError = error;
    }
  }
  const sameHost2 = node.hostName === os.hostname() && ["127.0.0.1", "[::1]", "localhost"].includes(new URL(runtimeUrl()).hostname);
  const evidence = { sameHost: sameHost2, pairingSessions, now: Date.now() };
  const confirmed = agents.filter((a) => {
    const routes = byAgent.get(a.id), preferred = routes.filter((e) => e.preferred === true);
    return (preferred.length ? preferred : routes).every((e) => e.nodeId === node.id && hasReceiveRoute(e, evidence));
  });
  if (!confirmed.length && pairingError) throw pairingError;
  return confirmed.map((a) => ({ id: a.id, name: a.displayName || a.id })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
let names = { at: 0, map: /* @__PURE__ */ new Map() };
async function actorNames() {
  if (Date.now() - names.at < 3e5) return names.map;
  try {
    const s = await get("/v1/snapshot?scope=identity", 2e4);
    const map = /* @__PURE__ */ new Map();
    for (const a of Object.values(s.actors || {})) map.set(a.id, a.displayName || a.handle || a.id);
    names = { at: Date.now(), map };
  } catch {
  }
  return names.map;
}
const sessionish = (id, name) => /^session-/.test(id) || /^Session [A-Za-z0-9]+ [A-Za-z0-9]+$/.test(name || "");
async function messages(conversationId, { limit = 200, agentName = null, messageId = null } = {}) {
  const list = await get(`/v1/messages?conversationId=${encodeURIComponent(conversationId)}&limit=${limit}`);
  if (messageId && !list.some((message) => message.id === messageId) && messageId !== "." && messageId !== "..") {
    const response = await fetch(`${runtimeUrl()}/v1/messages/${encodeURIComponent(messageId)}`, { signal: AbortSignal.timeout(8e3) });
    if (response.ok) {
      const { message } = await response.json();
      if (message?.id === messageId && message.conversationId === conversationId) list.push(message);
    } else if (response.status !== 404) {
      throw new Error(`Couldn't read the linked message (${response.status}).`);
    }
  }
  const map = await actorNames();
  return list.filter((m) => m.class === "agent" || m.class === "artifact").map((m) => ({
    id: m.id,
    actorId: m.actorId,
    name: m.actorId === "operator" ? "You" : agentName && sessionish(m.actorId, map.get(m.actorId)) ? agentName : map.get(m.actorId) || m.actorId,
    mine: m.actorId === "operator",
    body: m.body,
    at: m.createdAt,
    replyTo: m.replyToMessageId || null
  })).sort((a, b) => a.at - b.at);
}
async function post({ conversationId, target, body, requestId = randomUUID() }, key) {
  const n = await nodeInfo();
  if (!n.keyId) throw new Error("the runtime didn't name its key, so a post can't be signed");
  const id = `chat-${requestId}`;
  const [p, payload] = target ? ["/v1/deliver", {
    id,
    requestId,
    requesterId: "operator",
    requesterNodeId: n.id,
    targetAgentId: target.id,
    body,
    intent: "consult",
    ensureAwake: true,
    messageMetadata: { source: "scout-chat" }
  }] : ["/v1/messages", {
    id,
    requestId,
    conversationId,
    actorId: "operator",
    originNodeId: n.id,
    class: "agent",
    body,
    visibility: "workspace",
    policy: "durable",
    createdAt: Date.now(),
    metadata: { source: "scout-chat" }
  }];
  const text2 = JSON.stringify(payload);
  const res = await fetch(`${runtimeUrl()}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...sign(key, { method: "POST", path: p, body: text2, destinationKeyId: n.keyId }) },
    body: text2,
    redirect: "error",
    signal: AbortSignal.timeout(15e3)
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || out.message || `the runtime refused the post (${res.status})`);
  if (target) {
    const roomId = out.receipt?.conversationId || out.conversation?.id;
    const messageId = out.receipt?.messageId || out.message?.id;
    if (out.kind !== "delivery" || out.accepted !== true || !roomId || !messageId)
      throw new Error(out.reason || "Scout didn't confirm acceptance of the ask.");
    const actualId = out.receipt?.targetAgentId || out.targetAgentId || target.id;
    return {
      kind: "ask",
      requestId,
      id: messageId,
      conversationId: roomId,
      agent: actualId === target.id ? target.name : actualId
    };
  }
  if (out.ok !== true || !out.message?.id) throw new Error("Scout didn't confirm the post.");
  return { kind: "post", requestId, conversationId, id: out.message.id };
}
function follow({ onMessage, onConnection, onTargets }) {
  const lifetime = new AbortController();
  (async function loop(n = 0) {
    while (!lifetime.signal.aborted) {
      try {
        const res = await fetch(`${runtimeUrl()}/v1/events/stream`, { signal: lifetime.signal });
        if (!res.ok || !res.body) {
          await res.body?.cancel();
          throw new Error(String(res.status));
        }
        onConnection("connected");
        n = 0;
        const decoder = new TextDecoder();
        let buf = "", ev = "";
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, "");
            buf = buf.slice(i + 1);
            if (line.startsWith("event:")) ev = line.slice(6).trim();
            else if (line.startsWith("data:") && (ev === "message.posted" || ev === "message.corrected")) {
              try {
                const d = JSON.parse(line.slice(5));
                onMessage(d.payload?.message?.conversationId || d.message?.conversationId || null);
              } catch {
              }
            } else if (line.startsWith("data:") && (ev === "agent.registered" || ev.startsWith("agent.endpoint."))) {
              onTargets();
            } else if (!line) ev = "";
          }
        }
      } catch {
      }
      if (lifetime.signal.aborted) break;
      onConnection("reconnecting");
      await setTimeout(Math.min(3e4, 1e3 * 2 ** Math.min(n++, 5)), void 0, { signal: lifetime.signal }).catch(() => {
      });
    }
  })();
  return () => lifetime.abort();
}
const APP = "scout-chat";
function hello() {
  return { app: APP, instance: createHash("sha256").update(runtimeUrl()).digest("hex") };
}
const exe = (p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return p;
  } catch {
    return null;
  }
};
function onPath(name) {
  for (const d of [...(process.env.PATH || "").split(":"), path.join(os.homedir(), ".bun", "bin"), path.join(os.homedir(), ".local", "bin")]) {
    const p = d && exe(path.join(d, name));
    if (p) return p;
  }
  return null;
}
function findScout() {
  if (process.env.SCOUT_BIN) return exe(process.env.SCOUT_BIN);
  try {
    return onPath("scout") || exe(path.join(path.dirname(createRequire(import.meta.url).resolve("@openscout/scout/package.json")), "bin", "scout"));
  } catch {
    return null;
  }
}
const findBun = () => process.env.BUN_INSTALL && exe(path.join(process.env.BUN_INSTALL, "bin", "bun")) || onPath("bun");
const cliEnv = (runtime) => {
  const bun = findBun();
  return { ...process.env, ...{ OPENSCOUT_BROKER_URL: runtimeUrl() }, ...bun ? { PATH: `${path.dirname(bun)}:${process.env.PATH || ""}` } : {} };
};
async function runScout(bin, argv) {
  try {
    const { stdout } = await promisify(execFile)(bin, argv, { env: cliEnv(true), timeout: argv[1] === "connect" ? 95e3 : 35e3, maxBuffer: 256 * 1024 });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, stderr: err.stderr || "", stdout: err.stdout || "" };
  }
}
function hasLocalCompanion(bin) {
  try {
    const root = path.dirname(path.dirname(fs.realpathSync(bin)));
    return ["packages/slack/dist/main.js", "packages/slack/src/main.ts"].some((p) => fs.existsSync(path.join(root, p)));
  } catch {
    return false;
  }
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
    try {
      u = new URL(url);
      name = decodeURIComponent(u.pathname.split("/").filter(Boolean).at(-1));
    } catch {
      throw inputError(invalid);
    }
    const teams = [...u.searchParams];
    if (u.origin !== "https://api.vercel.com" || u.username || u.password || u.hash || !/^\/v\d+\/messageboard\/boards\/[^/]+\/?$/.test(u.pathname) || !/^[^/\u0000-\u001f]{1,64}$/.test(name) || tokenShaped(name) || teams.length !== 1 || !["teamId", "slug"].includes(teams[0][0]) || !/^[A-Za-z0-9_-]{1,128}$/.test(teams[0][1]) || tokenShaped(teams[0][1])) throw inputError(invalid);
  }
  if (board && (!/^[^/\u0000-\u001f]{1,64}$/.test(board) || tokenShaped(board) || cliOption(board))) throw inputError("Enter a Board name.");
  return [
    "integration",
    "connect",
    "vercel-board",
    ...url ? ["--url", url] : ["--team", team],
    "--credential",
    credential,
    ...board ? ["--board", board] : []
  ];
}
function slackArgs(input) {
  const project = text(input.project), agent = text(input.agent);
  if (!project || project.length > 4096 || /[\r\n\0]/.test(project)) throw inputError("Enter the path to a registered Scout project.");
  if (agent && (!/^[A-Za-z0-9._:@-]{1,128}$/.test(agent) || cliOption(agent))) throw inputError("Enter a Scout agent ID.");
  return ["integration", "setup", "slack", "--project", path.resolve(project), ...agent ? ["--agent", agent] : [], "--json"];
}
const blocked = (message) => ({ available: false, message });
function createIntegrations({ up: up$1 = up, find = findScout, run = runScout, hasCompanion = hasLocalCompanion } = {}) {
  async function capability(kind, bin, online) {
    if (!online) return blocked(runtimeDown);
    if (!bin) return blocked(noCli);
    if (kind === "board") {
      const r2 = await run(bin, ["integration", "status", "vercel-board"]);
      if (!r2.ok && /operation not found|unknown (?:command|route)|HTTP 404/i.test(`${r2.stdout}${r2.stderr}`)) return blocked(upgrade);
      if (!r2.ok) return blocked("Scout couldn't check Board support. Run scout integration status vercel-board on this host.");
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
      const bin = find(), online = await up$1();
      const [board, slack] = await Promise.all(["board", "slack"].map((kind) => capability(kind, bin, online)));
      return { board, slack };
    },
    async connect(kind, input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw inputError("Send the connection details as a JSON object.");
      const argv = kind === "board" ? boardArgs(input) : slackArgs(input);
      const bin = find();
      const support = await capability(kind, bin, await up$1());
      if (!support.available) throw Object.assign(new Error(support.message), { status: 409 });
      const r = await run(bin, argv);
      if (!r.ok) throw Object.assign(new Error(kind === "board" ? "Scout couldn't connect the Board. Check the team or URL and the secret_cli entry on this host." : "Scout couldn't start Slack setup. Check that the project and agent are registered on this host."), { status: 502 });
      if (kind === "board") return { message: "Board connected. Rooms appear as its channels sync." };
      let operation;
      try {
        operation = JSON.parse(r.stdout).operation;
      } catch {
      }
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
          `Run scout integration start ${id} --if-revision <revision>. Once the app answers a test mention and threaded follow-up, run scout integration verify ${id} --if-revision <revision>.`
        ]
      };
    }
  };
}
const integrations = createIntegrations();
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8"
};
const THIN_SHARED_PATHS = /* @__PURE__ */ new Set([
  "/api/host-status",
  "/api/setup",
  "/api/recent-sessions",
  "/api/session-context",
  "/api/messages",
  "/v1/events/stream",
  "/v1/tail/events"
]);
function isThinSharedRoute(pathname) {
  return THIN_SHARED_PATHS.has(pathname) || pathname.startsWith("/api/session-ref/");
}
function sameHost(host, port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`].includes(String(host || "").toLowerCase());
}
function allowedWrite(headers, port) {
  const host = String(headers.host || "").toLowerCase();
  return sameHost(headers.host, port) && headers.origin === `http://${host}`;
}
const jsonWrite = (headers, port) => allowedWrite(headers, port) && /^application\/json(?:\s*;|$)/i.test(String(headers["content-type"] || ""));
const handleThinRoutes = createScoutThinHttpHandler({
  packageName: "@openscout/chat",
  product: "Chat",
  apiHandler: async (req, res, { pathname }) => {
    if (req.method === "GET" && pathname === "/api/host-status") {
      const base = runtimeUrl$1();
      const runtimeUp = await checkRuntime(base);
      const localSessions = scanLocalFeedSessions({ maxPerHarness: 15, limit: 30 }).length;
      sendJson(res, 200, { runtimeUp, runtimeUrl: base, localSessions });
      return true;
    }
    return false;
  }
});
function createServer({
  port,
  key,
  keyProblem,
  integrations: integrations$1 = integrations
} = {}) {
  const streams = /* @__PURE__ */ new Set();
  const operatorKey = () => key === void 0 && keyProblem === void 0 ? readKey() : { key, problem: keyProblem };
  let stopFollowing;
  let connection = "connecting";
  const event = (name, data) => `event: ${name}
data: ${JSON.stringify(data)}

`;
  const broadcast = (name, data) => {
    for (const res of streams) res.write(event(name, data));
  };
  const onConnection = (next) => {
    if (connection === next) return;
    connection = next;
    broadcast("connection", connection);
  };
  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let n = 0;
    const parts = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > 64e3) {
        reject(new Error("too large"));
        req.destroy();
      } else {
        parts.push(c);
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"));
      } catch {
        reject(new Error("not JSON"));
      }
    });
    req.on("error", reject);
  });
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const addr = server.address();
    const localPort = port || (typeof addr === "object" && addr ? addr.port : void 0);
    if (!sameHost(req.headers.host, localPort)) {
      res.writeHead(421);
      res.end();
      return;
    }
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const p = url.pathname;
    try {
      if (isThinSharedRoute(p)) {
        if (await handleThinRoutes(req, res)) return;
      }
      if (p === "/api/hello" && req.method === "GET") return json(res, 200, hello());
      if (p === "/api/status") return json(res, 200, await readiness(operatorKey()));
      if (p === "/api/integrations" && req.method === "GET") return json(res, 200, await integrations$1.status());
      const connect = p.match(/^\/api\/integrations\/(board|slack)$/);
      if (connect && req.method === "POST") {
        if (!jsonWrite(req.headers, localPort)) return json(res, 403, { error: "posts come from this page only" });
        let body;
        try {
          body = await readBody(req);
        } catch {
          return json(res, 400, { error: "Send the connection details as JSON." });
        }
        try {
          return json(res, 200, await integrations$1.connect(connect[1], body));
        } catch (e) {
          const err = e;
          const known = err.status === 400 || err.status === 409 || err.status === 502;
          return json(res, known ? err.status : 502, {
            error: known ? err.message : "Scout couldn't finish the request."
          });
        }
      }
      if (p === "/api/rooms") {
        const rooms$1 = await rooms();
        return json(res, 200, rooms$1.length ? { rooms: rooms$1 } : { rooms: rooms$1, targets: await askTargets().catch(() => null) });
      }
      const m = p.match(/^\/api\/rooms\/([^/]+)\/messages$/);
      let roomId;
      if (m) {
        try {
          roomId = decodeURIComponent(m[1]);
        } catch {
          return json(res, 400, { error: "Invalid room address." });
        }
      }
      if (m && req.method === "GET") {
        const room = (await rooms()).find((r) => r.id === roomId);
        return json(res, 200, {
          knownRoom: !!room,
          messages: await messages(roomId, {
            agentName: room?.kind === "direct" ? room.agentName : null,
            messageId: url.searchParams.get("message")
          })
        });
      }
      const firstAsk = p === "/api/ask";
      if ((m || firstAsk) && req.method === "POST") {
        if (!jsonWrite(req.headers, localPort)) return json(res, 403, { error: "posts come from this page only" });
        const { key: opKey, problem } = operatorKey();
        if (!opKey) return json(res, 409, { error: problem || "posting isn't set up" });
        let data;
        try {
          data = await readBody(req);
        } catch {
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          return json(res, 400, { error: "Send the message as JSON." });
        }
        const { body, requestId, targetAgentId } = data;
        if (requestId !== void 0 && (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId))) {
          return json(res, 400, { error: "Invalid request ID." });
        }
        const text2 = typeof body === "string" ? body.trim() : "";
        if (!text2) return json(res, 400, { error: "write something first" });
        if (firstAsk) {
          const target = (await askTargets()).find((a) => a.id === targetAgentId);
          if (!target) return json(res, 409, { error: "That agent is no longer available." });
          return json(res, 200, await post({ target, body: text2, requestId }, opKey));
        }
        const room = (await rooms()).find((r) => r.id === roomId);
        if (!room) return json(res, 404, { error: "that room isn't on this host" });
        if (targetAgentId !== void 0 && targetAgentId !== (room.askTarget?.id ?? null)) {
          return json(res, 409, { error: "The room’s recipient changed. Check the room before sending." });
        }
        return json(
          res,
          200,
          await post({ conversationId: room.id, target: room.askTarget, body: text2, requestId }, opKey)
        );
      }
      if (p === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive"
        });
        res.write(event("connection", connection));
        streams.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25e3);
        req.on("close", () => {
          clearInterval(ping);
          streams.delete(res);
        });
        return;
      }
      if (p.startsWith("/api/")) return json(res, 404, { error: "no such route" });
      const rel = path.normalize(p).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
      let file = path.join(DIST, rel || "index.html");
      if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(DIST, "index.html");
      }
      if (!fs.existsSync(file)) {
        sendJson(res, 503, { error: "dist/index.html is missing. Run npm run build first." });
        return;
      }
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file)] || "application/octet-stream",
        "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=3600"
      });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      const err = e;
      const down = /fetch failed|ECONNREFUSED|timeout/i.test(String(err?.cause?.code || err?.message || e));
      json(res, down ? 503 : 502, {
        error: down ? "Scout's runtime isn't answering on this host" : String(err?.message || e)
      });
    }
  });
  server.on("listening", () => {
    stopFollowing = follow({
      onMessage: (conversationId) => broadcast("message", { conversationId }),
      onConnection,
      onTargets: () => broadcast("targets", null)
    });
  });
  server.on("close", () => {
    stopFollowing?.();
    for (const s of streams) s.end();
  });
  return server;
}
function serve(port) {
  const server = createServer({ port });
  return new Promise((resolve, reject) => {
    server.once("error", reject).listen(port, "127.0.0.1", () => resolve(server));
  });
}
export {
  DIST,
  allowedWrite,
  createServer,
  sameHost,
  serve
};
