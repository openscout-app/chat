// Loopback launcher identity describes the configured runtime, even when it is offline.
import { createHash } from "node:crypto";
import { runtimeUrl } from "./runtime.mjs";

export const FIRST_PORT = 4804;
export const APP = "scout-chat";

export function hello() {
  // Do not publish the configured URL (it may include private connection details).
  return { app: APP, instance: createHash("sha256").update(runtimeUrl()).digest("hex") };
}

export function portOptions(args, envPort) {
  const i = args.findIndex((arg) => arg === "--port" || arg.startsWith("--port="));
  const strict = i >= 0 || Boolean(envPort);
  const raw = i < 0 ? envPort : args[i] === "--port" ? args[i + 1] : args[i].slice("--port=".length);
  if (!strict) return { first: FIRST_PORT, strict };
  if (!/^\d+$/.test(raw ?? "") || Number(raw) < 1 || Number(raw) > 65535)
    throw new Error("--port takes a port number from 1 to 65535.");
  return { first: Number(raw), strict };
}

export async function ours(port, expected = hello()) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/hello`, {
      redirect: "error", signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) { await res.body?.cancel(); return false; }
    const found = await res.json();
    return found?.app === expected.app && found.instance === expected.instance;
  } catch { return false; }
}

const lastPort = (first, tries) => Math.min(65535, first + tries - 1);
const urlFor = (port) => `http://localhost:${port}`;

export async function running(first = FIRST_PORT, tries = 10, expected = hello()) {
  for (let p = first; p <= lastPort(first, tries); p++) if (await ours(p, expected)) return p;
  return 0;
}

/** Reuse before binding: a hole may have opened before a matching fallback listener. */
export async function start({ first = FIRST_PORT, strict = false, serve, tries = 10 }) {
  const expected = hello();
  const reuse = (port) => ({ url: urlFor(port), port, reused: true, server: null });
  const last = lastPort(first, strict ? 1 : tries);
  const existing = await running(first, last - first + 1, expected);
  if (existing) return reuse(existing);
  for (let port = first; port <= last; port++) {
    try {
      const server = await serve(port);
      return { url: urlFor(port), port, reused: false, server };
    } catch (e) {
      if (e.code !== "EADDRINUSE") throw e;
      // Check again after the bind race, including another launcher that just won it.
      if (await ours(port, expected)) return reuse(port);
      if (strict) throw new Error(`port ${port} is taken. Try another --port.`);
    }
  }
  throw new Error(`ports ${first} to ${last} are all taken. Use --port <n>.`);
}
