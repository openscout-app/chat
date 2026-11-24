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

// One mounted field can switch destinations; in-flight work belongs to its draft, not the DOM.
export function composer({ el, drafts, submit, accepted }) {
  let destination, draft, problem;
  const ta = el("textarea", { rows: 1 });
  const send = el("button", { className: "send", type: "submit" }, sendGlyph());
  const hint = el("p", { className: "hint", role: "status" });
  const form = el("form", { className: "composer" }, el("div", { className: "field" }, ta, send), hint);
  function paint() {
    if (!draft) return;
    if (ta.value !== draft.text) ta.value = draft.text;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
    ta.disabled = !!problem;
    send.disabled = !!problem || !!draft.pending || !draft.text.trim();
    const status = draft.pending ? "Sending…" : problem || draft.notice;
    if (hint.textContent !== status) hint.textContent = status;
    hint.classList.toggle("error", !problem && !!draft.error);
  }
  ta.addEventListener("beforeinput", () => {
    // Replacing the selection can produce a new draft with the very same prefix.
    if (draft.pending && ta.selectionStart < draft.pending.raw.length) draft.pending.prefixIntact = false;
  });
  ta.addEventListener("input", () => {
    draft.text = ta.value;
    if (!draft.pending && draft.retry?.body !== draft.text.trim()) {
      draft.notice = "";
      draft.error = false;
    }
    if (draft.pending && !draft.text.startsWith(draft.pending.raw)) draft.pending.prefixIntact = false;
    paint();
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (!e.repeat) form.requestSubmit();
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (problem || !draft || draft.pending || !draft.text.trim()) return;
    const owner = draft, to = destination;
    const body = owner.text.trim(), targetAgentId = to.target?.id ?? null;
    const previous = owner.retry;
    const requestId = previous?.body === body && previous.targetAgentId === targetAgentId
      ? previous.requestId : crypto.randomUUID();
    const payload = { body, requestId, targetAgentId };
    const pending = { raw: owner.text, prefixIntact: true };
    owner.pending = pending;
    owner.error = false;
    paint();
    let receipt;
    try {
      receipt = await submit(to.path, payload);
      if (!["post", "ask"].includes(receipt.kind) || (receipt.kind === "ask" && !receipt.agent))
        throw new Error("Scout didn’t confirm the send.");
      if (pending.prefixIntact) owner.text = owner.text.slice(pending.raw.length);
      owner.notice = receipt.kind === "ask" ? `Ask accepted by ${receipt.agent}` : "Posted to room";
      owner.retry = null;
    } catch (err) {
      owner.retry = payload;
      owner.error = true;
      owner.notice = err.message;
    } finally {
      owner.pending = null;
      if (owner === draft) paint();
    }
    if (!owner.error) accepted(to, receipt, owner);
  });
  return {
    form,
    show(to, readOnlyReason) {
      destination = to;
      problem = readOnlyReason;
      form.hidden = !to;
      draft = null;
      if (!to) return;
      if (!drafts.has(to.key)) drafts.set(to.key, { text: "", notice: "" });
      draft = drafts.get(to.key);
      const cue = to.target ? `Ask ${to.target.name}` : "Post to room";
      ta.placeholder = cue;
      ta.setAttribute("aria-label", cue);
      send.title = cue;
      send.setAttribute("aria-label", cue);
      paint();
    },
  };
}
