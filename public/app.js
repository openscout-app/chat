// Scout Chat's page: rooms on the left, one room on the right, and a composer that posts in your name.
const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null) n.append(k);
  return n;
};
const api = async (p, init) => {
  const r = await fetch(p, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `${r.status}`);
  return d;
};

const state = { rooms: [], current: null, status: null };

function when(t) {
  if (!t) return "";
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = (now - d) / 864e5;
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function renderRooms() {
  const nav = $("#room-list");
  nav.replaceChildren();
  const groups = [
    ["Channels", state.rooms.filter((r) => r.kind === "channel")],
    ["Direct", state.rooms.filter((r) => r.kind === "direct")],
  ];
  for (const [name, list] of groups) {
    if (!list.length) continue;
    const g = el("section", { className: "group" }, el("h2", { textContent: name }));
    for (const r of list) {
      const title = el("span", { className: "title", textContent: r.title });
      if (r.board) title.append(el("span", { className: "tag", textContent: "Board" }));
      const b = el("button", { className: `item${r.unread ? " unread" : ""}`, type: "button" },
        title, el("span", { className: "when", textContent: when(r.lastAt) }),
        r.preview ? el("span", { className: "preview", textContent: r.preview }) : null);
      b.setAttribute("aria-current", String(state.current === r.id));
      b.addEventListener("click", () => openRoom(r.id));
      g.append(b);
    }
    nav.append(g);
  }
  if (!state.rooms.length) {
    nav.append(el("p", { className: "group quiet", textContent: state.status?.runtime
      ? "No rooms yet. Ask an agent with scout ask, or add a Vercel Board below."
      : "Scout's runtime isn't answering on this host. Run scout-chat setup." }));
  }
}

let renderToken = 0;
async function openRoom(id) {
  state.current = id;
  history.replaceState(null, "", `#${encodeURIComponent(id)}`);
  renderRooms();
  const room = state.rooms.find((r) => r.id === id);
  const main = $("#room");
  const log = el("div", { className: "log" }, el("p", { className: "quiet", textContent: "Loading" }));
  const head = el("header", { className: "room-head" },
    el("h1", { textContent: room?.title || id }),
    el("span", { className: "sub", textContent: room?.kind === "direct"
      ? `Direct with ${room.agentName || "an agent"}`
      : room?.board ? "A Vercel Board channel" : "Channel" }));
  main.replaceChildren(head, log, composer(room));
  await loadMessages(id, log);
}

async function loadMessages(id, log = $(".log")) {
  const token = ++renderToken;
  try {
    const { messages } = await api(`/api/rooms/${encodeURIComponent(id)}/messages`);
    if (token !== renderToken || state.current !== id) return;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    log.replaceChildren(...(messages.length ? messages.map((m) => el("article", { className: `msg${m.mine ? " mine" : ""}` },
      el("div", { className: "who" }, m.name, el("time", { textContent: when(m.at), dateTime: new Date(m.at).toISOString() })),
      el("div", { className: "body", textContent: m.body }))) : [el("p", { className: "quiet", textContent: "Nothing here yet." })]));
    if (nearBottom || log.dataset.loaded !== id) log.scrollTop = log.scrollHeight;
    log.dataset.loaded = id;
  } catch (e) {
    if (token === renderToken) log.replaceChildren(el("p", { className: "quiet", textContent: e.message }));
  }
}

const sendGlyph = () => {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "16"); svg.setAttribute("height", "16"); svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", "M8 13V3.5M3.75 7.5 8 3.25l4.25 4.25");
  p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor"); p.setAttribute("stroke-width", "1.6");
  p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
  svg.append(p);
  return svg;
};

function composer(room) {
  const canPost = Boolean(state.status?.canPost);
  const ta = el("textarea", { rows: 1, placeholder: room?.kind === "direct" ? `Ask ${room.agentName || "the agent"}` : "Write to the room", disabled: !canPost });
  const send = el("button", { className: "send", type: "submit", title: "Send", disabled: true }, sendGlyph());
  send.setAttribute("aria-label", "Send");
  const hint = el("p", { className: "hint", textContent: canPost ? "" : `Reading only: ${state.status?.why || "posting isn't set up"}.` });
  const form = el("form", { className: "composer" }, el("div", { className: "field" }, ta, send), hint);
  const fit = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`; send.disabled = !canPost || !ta.value.trim(); };
  ta.addEventListener("input", fit);
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = ta.value.trim();
    if (!body || !room) return;
    send.disabled = true; hint.className = "hint"; hint.textContent = "Sending";
    try {
      await api(`/api/rooms/${encodeURIComponent(room.id)}/messages`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }),
      });
      ta.value = ""; fit(); hint.textContent = room.kind === "direct" ? `Sent. ${room.agentName || "The agent"} will answer here.` : "";
      loadMessages(room.id);
    } catch (err) {
      hint.className = "hint error"; hint.textContent = err.message; fit();
    }
  });
  return form;
}

async function refreshRooms() {
  try { state.rooms = (await api("/api/rooms")).rooms; } catch { state.rooms = []; }
  renderRooms();
}

const panel = $(".integration-panel");
const integrationForm = $("#integration-form");
const fields = $("#integration-fields");
const capability = $("#integration-capability");
const result = $("#integration-result");
const steps = $("#integration-steps");
let panelRequest = 0;

function inputField(label, name, { help, ...props } = {}) {
  const input = el("input", { name, required: true, spellcheck: false, ...props });
  const note = help ? el("small", { id: `help-${name}`, textContent: help }) : null;
  if (note) input.setAttribute("aria-describedby", note.id);
  return el("label", {}, el("span", { textContent: label }), input, note);
}

let syncTimer;
function refreshAfterConnect(kind) {
  refreshRooms();
  if (kind !== "board") return;
  clearInterval(syncTimer);
  let remaining = 12;
  syncTimer = setInterval(() => {
    refreshRooms();
    if (--remaining === 0) clearInterval(syncTimer);
  }, 5000);
}

async function openIntegration(kind, title) {
  const request = ++panelRequest;
  $("#integration-title").textContent = title;
  capability.textContent = "Checking this host…";
  result.textContent = "";
  steps.replaceChildren();
  steps.hidden = true;
  fields.replaceChildren();
  integrationForm.hidden = true;
  panel.showModal();
  $("#integration-title").focus();

  try {
    const support = (await api("/api/integrations"))[kind];
    if (request !== panelRequest || !panel.open) return;
    capability.textContent = support.message || "";
    if (!support.available) return;
    if (kind === "board") {
      fields.append(
        inputField("Team ID, slug, or Board API URL", "target", { maxLength: 512, help: "The team slug is the name in vercel.com/<team>." }),
        inputField("Credential entry name", "entry", {
          type: "password", autocomplete: "off", maxLength: 128,
          help: "Make a token on Vercel scoped to your team. Store it on this host with secret set <entry>. Enter the entry name here, not the token.",
        }),
      );
    } else {
      fields.append(
        inputField("Project path", "project", { help: "Use the full path to a registered Scout project." }),
        inputField("Agent ID (optional)", "agent", { required: false, maxLength: 128 }),
      );
    }
    const submit = integrationForm.querySelector("button");
    submit.disabled = false;
    submit.textContent = kind === "board" ? "Connect Board" : "Start Slack setup";
    integrationForm.hidden = false;
    integrationForm.onsubmit = async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      const data = new FormData(integrationForm);
      let body;
      if (kind === "board") {
        const entry = data.get("entry").trim();
        const target = data.get("target").trim();
        integrationForm.elements.entry.value = "";
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(entry) || /^(vcp|vck|vca)_|^[A-Za-z0-9]{24,}$/i.test(entry)) {
          result.textContent = "Enter the name of a secret_cli entry, not the token itself.";
          integrationForm.elements.entry.focus();
          return;
        }
        body = { [/^[a-z]+:\/\//i.test(target) ? "url" : "team"]: target, credential: `secret_cli:${entry}` };
      } else {
        body = { project: data.get("project"), agent: data.get("agent") };
      }
      submit.disabled = true;
      result.textContent = kind === "board" ? "Connecting Board…" : "Starting Slack setup…";
      try {
        const receipt = await api(`/api/integrations/${kind}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        refreshAfterConnect(kind);
        if (request !== panelRequest || !panel.open) return;
        integrationForm.hidden = true;
        capability.textContent = receipt.warning || "";
        result.textContent = receipt.message;
        if (receipt.steps?.length) {
          steps.replaceChildren(...receipt.steps.map((step) => el("li", { textContent: step })));
          steps.hidden = false;
        }
        result.focus();
      } catch (err) {
        if (request === panelRequest && panel.open) {
          result.textContent = err.message;
          submit.disabled = false;
        }
      }
    };
  } catch {
    if (request === panelRequest && panel.open) capability.textContent = "Couldn't check this host. Close this panel and try again.";
  }
}

panel.addEventListener("close", () => fields.replaceChildren());
document.querySelectorAll("[data-integration]").forEach((button) => {
  button.addEventListener("click", () => openIntegration(button.dataset.integration, button.textContent.trim()));
});

async function start() {
  try { state.status = await api("/api/status"); } catch { state.status = null; }
  $("#host").textContent = state.status?.host ? `on ${state.status.host}` : "";
  $("#status").textContent = !state.status?.runtime ? "Scout's runtime isn't answering. Run scout-chat setup."
    : state.status.canPost ? "" : `Reading only: ${state.status.why}.`;
  await refreshRooms();
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (fromHash && state.rooms.some((r) => r.id === fromHash)) openRoom(fromHash);

  let pending = null;
  const events = new EventSource("/api/events");
  events.addEventListener("message", (e) => {
    let id = null; try { id = JSON.parse(e.data).conversationId; } catch {}
    if (id && id === state.current) loadMessages(id);
    clearTimeout(pending); pending = setTimeout(refreshRooms, 400);
  });
}
start();
