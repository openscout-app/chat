import { composer } from "./composer.js";
// Scout Chat's page: rooms on the left, one room on the right, and a composer that posts in your name.
const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null) n.append(k);
  return n;
};
const api = async (p, init) => {
  const r = await fetch(p, init);
  const d = await r.json();
  if (!r.ok) throw Object.assign(new Error(d.error || `${r.status}`), { status: r.status });
  return d;
};

const state = {
  rooms: null, targets: null, status: null, current: null, message: null,
  stream: "connecting", errors: new Set(),
};
const drafts = new Map();
const narrow = matchMedia("(width < 720px)");
const empty = $("#empty"), recovery = $("#recovery"), conversation = $("#conversation");
const askPanel = $("#ask-panel"), askSelect = $("#ask-target");
let initialSelection = !history.state?.roomIndex;
let roomRead = 0, statusRead = 0, messageRead = 0;

function when(t) {
  if (!t) return "";
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if ((now - d) / 864e5 < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

// Leave unchanged nodes (and their text, focus and selection) in the document.
function patchList(parent, items, create, update) {
  const byId = new Map(Array.from(parent.children, (node) => [node.dataset.id, node]));
  const keep = new Set(items.map((item) => item.id));
  for (const [id, node] of byId) if (!keep.has(id)) node.remove();
  let next = parent.firstElementChild;
  for (const item of items) {
    const node = byId.get(item.id) || create(item);
    node.dataset.id = item.id;
    update(node, item);
    if (node !== next) {
      if (node.parentNode && parent.moveBefore) parent.moveBefore(node, next);
      else parent.insertBefore(node, next);
    }
    next = node.nextElementSibling;
  }
}

function roomURL(id) {
  const url = new URL(location.href);
  url.searchParams.delete("message");
  url.hash = id ? encodeURIComponent(id) : "";
  return url;
}
function renderRooms() {
  for (const [groupId, kind] of [["channels", "channel"], ["direct", "direct"]]) {
    const group = $("#" + groupId);
    const rooms = (state.rooms || []).filter((r) => r.kind === kind);
    group.hidden = !rooms.length;
    patchList(group.lastElementChild, rooms, () =>
      el("a", { className: "item" },
        el("span", { className: "title" }, el("span"), el("span", { className: "tag", textContent: "Board" })),
        el("time", { className: "when" }), el("span", { className: "preview" })), (link, r) => {
      link.href = roomURL(r.id);
      link.setAttribute("aria-current", state.current === r.id ? "page" : "false");
      link.classList.toggle("unread", !!r.unread);
      setText(link.querySelector(".title span"), r.title);
      link.querySelector(".tag").hidden = !r.board;
      setText(link.querySelector("time"), when(r.lastAt));
      setText(link.querySelector(".preview"), r.preview);
    });
  }
}

function readLocation() {
  let id;
  try { id = decodeURIComponent(location.hash.slice(1)) || null; } catch { id = null; }
  return { id, message: id && new URL(location.href).searchParams.get("message") };
}
function remember(id) {
  try { localStorage.setItem("chat.lastRoom", id); } catch {}
}
function syncLocation(focus = false, load = true) {
  const { id, message } = readLocation();
  if (state.current === id && state.message === message) return;
  const previous = state.current;
  state.current = id;
  state.message = message;
  ++messageRead;
  state.errors.delete("messages");
  $("#messages").replaceChildren(); // Navigation, not a refresh of the current log.
  delete $(".log").dataset.loaded;
  logNote("Loading messages…");
  render();
  if (id) {
    if (state.rooms?.some((r) => r.id === id)) remember(id);
    if (focus && narrow.matches) $(".room-head h1").focus();
    if (load) loadMessages();
  } else if (focus) {
    const links = [...document.querySelectorAll(".item")];
    const fallback = !recovery.hidden ? $("#check") : !$("#first-ask").hidden ? $("#first-ask") : $(".brand .name");
    (links.find((a) => a.dataset.id === previous) || links[0] || fallback).focus();
  }
}
function navigate(id) {
  initialSelection = false;
  if (id === state.current && !state.message) return;
  if (!id && history.state?.fromIndex) { history.back(); return; }
  history.pushState(id ? { fromIndex: !state.current } : { roomIndex: true }, "", roomURL(id));
  syncLocation(true);
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a.item, a.rooms-back");
  if (!a || e.button || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  e.preventDefault();
  navigate(a.dataset.id || null);
});
for (const name of ["popstate", "hashchange"]) {
  window.addEventListener(name, () => { initialSelection = false; syncLocation(true); });
}
function selectInitialRoom() {
  if (!initialSelection || state.current || !state.rooms?.length || askPanel.open) return;
  initialSelection = false;
  let last;
  try { last = localStorage.getItem("chat.lastRoom"); } catch {}
  const id = state.rooms.find((r) => r.id === last)?.id || (state.rooms.length === 1 && state.rooms[0].id);
  if (id) { history.replaceState(null, "", roomURL(id)); syncLocation(); }
}

function logNote(text, linked = false) {
  const note = $("#log-note");
  setText(note, text);
  note.className = linked ? "link-notice" : "quiet";
  note.hidden = !text;
}
async function loadMessages() {
  const { current: id, message: linked } = state;
  if (!id) return;
  const token = ++messageRead;
  const log = $(".log");
  try {
    const search = linked ? "?" + new URLSearchParams({ message: linked }) : "";
    const { messages, knownRoom } = await api(`/api/rooms/${encodeURIComponent(id)}/messages${search}`);
    if (token !== messageRead) return;
    const followEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    let target;
    patchList($("#messages"), messages, () => el("article", { className: "msg" },
      el("div", { className: "who" }, el("span"), el("time")), el("div", { className: "body" })), (node, m) => {
      node.classList.toggle("mine", !!m.mine);
      setText(node.querySelector(".who span"), m.name);
      const time = node.querySelector("time");
      setText(time, when(m.at));
      time.dateTime = new Date(m.at).toISOString();
      setText(node.querySelector(".body"), m.body);
      if (linked === m.id) {
        target = node;
        node.classList.add("linked");
        node.setAttribute("aria-label", "Linked message");
      }
    });
    if (linked && !target) logNote("The linked message is unavailable in this discussion.", true);
    else if (messages.length) logNote("");
    else logNote(knownRoom ? "Nothing here yet." : "This discussion is unavailable.");
    if (target && !log.dataset.loaded) target.scrollIntoView({ block: "center" });
    else if (!linked && (!log.dataset.loaded || followEnd)) log.scrollTop = log.scrollHeight;
    log.dataset.loaded = "true";
    state.errors.delete("messages");
  } catch {
    if (token !== messageRead) return;
    state.errors.add("messages");
    if (!log.dataset.loaded) logNote("Couldn’t load this conversation.");
  }
  renderStatus();
}

async function send(path, payload) {
  try {
    return await api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  } catch (err) {
    if (err.status === 409) { refreshRooms(); refreshStatus(); }
    if (err instanceof TypeError || err instanceof SyntaxError) throw new Error("No receipt. Send the same text to retry.");
    throw err;
  }
}
const roomComposer = composer({ el, drafts, submit: send, accepted(to) {
  if (state.current === to.id) loadMessages();
}});
const askComposer = composer({ el, drafts, submit: send, accepted(to, receipt, draft) {
  const id = receipt.conversationId;
  if (id) {
    // The room can appear over SSE before the HTTP receipt comes back.
    const existing = drafts.get("room:" + id);
    if (existing) {
      if (draft.text) existing.text += (existing.text ? "\n" : "") + draft.text;
      existing.notice = draft.notice;
    } else drafts.set("room:" + id, draft);
    drafts.delete(to.key);
    if (askPanel.open && askSelect.value === to.target.id) {
      askPanel.close();
      navigate(id);
    }
    render();
  }
  refreshRooms();
}});
$("#room-composer").append(roomComposer.form);
$("#ask-composer").append(askComposer.form);

function updateAsk(opening = false) {
  const targets = state.targets || [];
  const selected = askSelect.value;
  const prompt = { id: "", name: targets.length ? "Choose an agent" : "No agent available" };
  patchList(askSelect, [prompt, ...targets], () => el("option"), (option, a) => {
    option.value = a.id;
    setText(option, a.name);
  });
  askSelect.value = opening && targets.length === 1 ? targets[0].id : targets.some((a) => a.id === selected) ? selected : "";
  const target = targets.find((a) => a.id === askSelect.value);
  askComposer.show(target && { key: "agent:" + target.id, path: "/api/ask", target }, postingProblem());
}
$("#first-ask").addEventListener("click", () => {
  askPanel.showModal();
  updateAsk(true);
  (askSelect.value ? askPanel.querySelector("textarea") : askSelect).focus();
});
askSelect.addEventListener("change", () => updateAsk());

function postingProblem() {
  if (!state.status || state.errors.has("status")) return "Checking whether Chat can send…";
  if (!state.status.runtime) return "Reading only while Scout is disconnected.";
  return state.status.canPost ? "" : `Reading only: ${state.status.why}.`;
}

function renderStatus() {
  const noRooms = state.rooms?.length === 0;
  const down = state.status && !state.status.runtime;
  const interrupted = state.errors.size > 0 || state.status?.readable === false;
  let issue = "";
  if (down) issue = "Scout’s runtime isn’t answering. Run setup, then check again.";
  else if (interrupted) issue = "Reconnecting…";
  else if (!state.current && noRooms && state.status?.canPost && !state.targets) issue = "Couldn’t check for agents.";
  // A verified room list (including a verified empty one) is usable while live updates reconnect.
  const ready = !state.current && !issue;
  if (!issue && state.stream === "reconnecting") issue = "Reconnecting…";
  recovery.hidden = !issue;
  $(".setup").hidden = !down;
  setText($("#connection-status"), issue);

  const choose = !!state.rooms?.length;
  let title = "Loading rooms…", detail = "";
  if (choose) {
    title = "Choose a room";
    detail = "Open a conversation from the room list.";
  } else if (noRooms && state.status) {
    title = "No rooms yet";
    detail = postingProblem() || (state.targets?.length ? "" : "Connect an agent to Scout to start a room.");
  }
  $("#empty-title").hidden = !ready || (choose && narrow.matches);
  setText($("#empty-title"), title);
  setText($("#empty-detail"), $("#empty-title").hidden ? "" : detail);
  $("#first-ask").hidden = !(ready && noRooms && state.status?.canPost && state.targets?.length);
  setText($("#status"), state.status?.runtime && choose && !state.status.canPost ? postingProblem() : "");
}

function render() {
  const id = state.current;
  const room = state.rooms?.find((r) => r.id === id);
  const target = room?.askTarget;
  const emptyParent = narrow.matches ? $("#index-empty") : $("#room");
  if (empty.parentNode !== emptyParent) emptyParent.prepend(empty);
  empty.hidden = !!id;
  conversation.hidden = !id;
  $(".frame").classList.toggle("in-room", !!id);
  if (id) {
    if (recovery.parentNode !== conversation) conversation.insertBefore(recovery, $(".log"));
    setText($(".room-head h1"), room?.title || id);
    setText($(".room-head .sub"), !room ? "Linked discussion" : target ? `Direct with ${target.name}`
      : room.board ? "Vercel Board channel" : room.kind === "direct" ? "Direct room" : "Channel");
  } else if (recovery.parentNode !== empty) empty.append(recovery);
  roomComposer.show(room && { id, key: "room:" + id, path: `/api/rooms/${encodeURIComponent(id)}/messages`, target }, postingProblem());
  setText($("#host"), state.status?.host ? `on ${state.status.host}` : "");
  renderRooms();
  renderStatus();
  if (askPanel.open) updateAsk();
}

async function refreshRooms() {
  const token = ++roomRead;
  try {
    const { rooms, targets } = await api("/api/rooms");
    if (token !== roomRead) return;
    if (!Array.isArray(rooms)) throw new Error("No room list.");
    state.rooms = rooms;
    // The picker may still be open when the first room arrives over SSE.
    if (!rooms.length) state.targets = targets;
    state.errors.delete("rooms");
    if (rooms.some((r) => r.id === state.current)) remember(state.current);
    selectInitialRoom();
  } catch {
    if (token !== roomRead) return;
    state.errors.add("rooms");
  }
  render();
}
async function refreshStatus() {
  const token = ++statusRead;
  try {
    const status = await api("/api/status");
    if (token !== statusRead) return;
    state.status = status;
    state.errors.delete("status");
  } catch {
    if (token !== statusRead) return;
    state.errors.add("status");
  }
  render();
}
function check() {
  return Promise.all([refreshStatus(), refreshRooms(), loadMessages()]);
}
$("#check").addEventListener("click", check);
$("#copy").addEventListener("click", async () => {
  const code = $("#setup-command");
  try {
    await navigator.clipboard.writeText(code.textContent);
    setText($("#copy"), "Copied");
  } catch {
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
});

const panel = $("#connections-panel");
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

narrow.addEventListener("change", render);
syncLocation(false, false);
render();

const events = new EventSource("/api/events");
let pending;
// A healthy stream opens with a connection event. Don't issue the same reads twice
// on launch, but don't make the first screen depend on a working stream either.
let startup = setTimeout(() => { startup = null; check(); }, 500);
events.addEventListener("connection", (e) => {
  const next = JSON.parse(e.data);
  state.stream = next;
  renderStatus();
  // The server sends its current upstream state to *every* new browser stream.
  // Re-read the projection and the open log; events lost during a gap won't replay.
  clearTimeout(startup);
  startup = null;
  check();
});
events.addEventListener("error", () => {
  if (startup) { clearTimeout(startup); startup = null; check(); }
  state.stream = "reconnecting";
  renderStatus();
});
function scheduleRoomRead() {
  pending ??= setTimeout(() => { pending = null; refreshRooms(); }, 400);
}
events.addEventListener("targets", () => {
  if (!state.rooms?.length || askPanel.open) scheduleRoomRead();
});
events.addEventListener("message", (e) => {
  const { conversationId } = JSON.parse(e.data);
  if (conversationId === state.current) loadMessages();
  scheduleRoomRead();
});
