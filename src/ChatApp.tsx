import { useCallback, useEffect, useRef, useState } from "react";

interface AskTarget {
  id: string;
  name: string;
}

interface Room {
  id: string;
  kind: "channel" | "direct";
  title: string;
  board?: boolean;
  unread?: boolean;
  lastAt?: number;
  preview?: string;
  askTarget?: AskTarget | null;
}

interface ChatMessage {
  id: string;
  name: string;
  body: string;
  at: number;
  mine?: boolean;
}

interface RuntimeStatus {
  listening?: boolean;
  readable?: boolean;
  writable?: boolean;
  runtime: string | null;
  host: string | null;
  nodeId?: string | null;
  canPost: boolean;
  why: string | null;
}

interface LocalSession {
  id: string;
  sessionId: string;
  title: string;
  asked?: string | null;
  project?: string | null;
  source?: string;
  at?: number;
}

interface IntegrationSupport {
  available: boolean;
  message?: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const data = await res.json();
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `${res.status}`), { status: res.status });
  }
  return data as T;
}

function formatWhen(t?: number): string {
  if (!t) return "";
  const d = new Date(t);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if ((now.getTime() - d.getTime()) / 864e5 < 7) {
    return d.toLocaleDateString([], { weekday: "short" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function readHashRoom(): string | null {
  try {
    return decodeURIComponent(window.location.hash.slice(1)) || null;
  } catch {
    return null;
  }
}

export function ChatApp({
  runtimeUp,
  onOpenSession,
}: {
  runtimeUp: boolean | null;
  onOpenSession: (sessionId: string) => void;
}) {
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [targets, setTargets] = useState<AskTarget[]>([]);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [localSessions, setLocalSessions] = useState<LocalSession[]>([]);
  const [currentRoomId, setCurrentRoomId] = useState<string | null>(() => readHashRoom());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [logNotice, setLogNotice] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [askOpen, setAskOpen] = useState(false);
  const [askTargetId, setAskTargetId] = useState("");
  const [askText, setAskText] = useState("");
  const [integrationKind, setIntegrationKind] = useState<"board" | "slack" | null>(null);
  const [integrationSupport, setIntegrationSupport] = useState<IntegrationSupport | null>(null);
  const [integrationResult, setIntegrationResult] = useState("");
  const [integrationSteps, setIntegrationSteps] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  const loadLocalSessions = useCallback(() => {
    api<{ sessions?: LocalSession[] }>("/api/recent-sessions")
      .then((res) => setLocalSessions(Array.isArray(res.sessions) ? res.sessions : []))
      .catch(() => {});
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await api<RuntimeStatus>("/api/status");
      setStatus(next);
    } catch {
      setStatus(null);
    }
  }, []);

  const refreshRooms = useCallback(async () => {
    try {
      const res = await api<{ rooms: Room[]; targets?: AskTarget[] | null }>("/api/rooms");
      setRooms(Array.isArray(res.rooms) ? res.rooms : []);
      if (Array.isArray(res.targets)) setTargets(res.targets);
    } catch {
      setRooms([]);
    }
  }, []);

  const loadMessages = useCallback(async (roomId: string | null) => {
    if (!roomId) return;
    setLogNotice("Loading messages…");
    try {
      const res = await api<{ knownRoom: boolean; messages: ChatMessage[] }>(
        `/api/rooms/${encodeURIComponent(roomId)}/messages`,
      );
      setMessages(res.messages);
      setLogNotice(res.messages.length ? "" : res.knownRoom ? "Nothing here yet." : "This discussion is unavailable.");
    } catch {
      setLogNotice("Couldn’t load this conversation.");
    }
  }, []);

  useEffect(() => {
    loadLocalSessions();
    void refreshStatus();
    void refreshRooms();
  }, [loadLocalSessions, refreshRooms, refreshStatus, runtimeUp]);

  useEffect(() => {
    const onHash = () => setCurrentRoomId(readHashRoom());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (currentRoomId) {
      void loadMessages(currentRoomId);
    }
  }, [currentRoomId, loadMessages]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages.length, currentRoomId]);

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("connection", () => {
      void refreshStatus();
      void refreshRooms();
      if (currentRoomId) void loadMessages(currentRoomId);
    });
    es.addEventListener("message", (e) => {
      try {
        const { conversationId } = JSON.parse((e as MessageEvent).data) as { conversationId?: string };
        if (conversationId && conversationId === currentRoomId) void loadMessages(currentRoomId);
      } catch {
        // ignore malformed event
      }
      void refreshRooms();
    });
    es.addEventListener("targets", () => {
      void refreshRooms();
    });
    return () => es.close();
  }, [currentRoomId, loadMessages, refreshRooms, refreshStatus]);

  const selectRoom = (id: string) => {
    window.location.hash = encodeURIComponent(id);
    setCurrentRoomId(id);
    setSendError("");
  };

  const currentRoom = rooms?.find((r) => r.id === currentRoomId) ?? null;
  const channels = (rooms ?? []).filter((r) => r.kind === "channel");
  const directs = (rooms ?? []).filter((r) => r.kind === "direct");
  const canSend = Boolean(status?.runtime && status.canPost);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentRoomId || !draft.trim() || sending || !canSend) return;
    setSending(true);
    setSendError("");
    try {
      await api(`/api/rooms/${encodeURIComponent(currentRoomId)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: draft.trim(),
          targetAgentId: currentRoom?.askTarget?.id ?? undefined,
        }),
      });
      setDraft("");
      await loadMessages(currentRoomId);
      await refreshRooms();
    } catch (err: unknown) {
      setSendError(err instanceof Error ? err.message : "Failed to send message.");
    } finally {
      setSending(false);
    }
  };

  const handleFirstAsk = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!askTargetId || !askText.trim() || sending) return;
    setSending(true);
    setSendError("");
    try {
      const receipt = await api<{ conversationId?: string }>("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetAgentId: askTargetId, body: askText.trim() }),
      });
      setAskOpen(false);
      setAskText("");
      await refreshRooms();
      if (receipt.conversationId) selectRoom(receipt.conversationId);
    } catch (err: unknown) {
      setSendError(err instanceof Error ? err.message : "Couldn’t send ask.");
    } finally {
      setSending(false);
    }
  };

  const openIntegration = async (kind: "board" | "slack") => {
    setIntegrationKind(kind);
    setIntegrationSupport(null);
    setIntegrationResult("");
    setIntegrationSteps([]);
    try {
      const res = await api<Record<"board" | "slack", IntegrationSupport>>("/api/integrations");
      setIntegrationSupport(res[kind]);
    } catch {
      setIntegrationSupport({ available: false, message: "Couldn't check this host." });
    }
  };

  const submitIntegration = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!integrationKind) return;
    const fd = new FormData(e.currentTarget);
    let body: Record<string, string>;
    if (integrationKind === "board") {
      const target = String(fd.get("target") || "").trim();
      const entry = String(fd.get("entry") || "").trim();
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(entry) || /^(vcp|vck|vca)_|^[A-Za-z0-9]{24,}$/i.test(entry)) {
        setIntegrationResult("Enter the name of a secret_cli entry, not the token itself.");
        return;
      }
      body = { [/^[a-z]+:\/\//i.test(target) ? "url" : "team"]: target, credential: `secret_cli:${entry}` };
    } else {
      body = {
        project: String(fd.get("project") || "").trim(),
        agent: String(fd.get("agent") || "").trim(),
      };
    }
    setIntegrationResult(integrationKind === "board" ? "Connecting Board…" : "Starting Slack setup…");
    try {
      const receipt = await api<{ message: string; steps?: string[] }>(`/api/integrations/${integrationKind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      setIntegrationResult(receipt.message);
      setIntegrationSteps(receipt.steps ?? []);
      void refreshRooms();
    } catch (err: unknown) {
      setIntegrationResult(err instanceof Error ? err.message : "Connection failed.");
    }
  };

  return (
    <div className="chat-standalone-surface">
      <div className={`chat-frame${currentRoomId ? " in-room" : ""}`}>
        <aside className="chat-rooms" aria-label="Rooms">
          <div className="chat-index-scroll">
            <nav aria-label="Conversations">
              {channels.length > 0 && (
                <section className="chat-group">
                  <h2>Channels</h2>
                  {channels.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className={`chat-item${r.unread ? " unread" : ""}`}
                      aria-current={currentRoomId === r.id ? "page" : undefined}
                      onClick={() => selectRoom(r.id)}
                    >
                      <span className="chat-title">
                        <span>{r.title}</span>
                        {r.board && <span className="chat-tag">Board</span>}
                      </span>
                      <time className="chat-when">{formatWhen(r.lastAt)}</time>
                      {r.preview && <span className="chat-preview">{r.preview}</span>}
                    </button>
                  ))}
                </section>
              )}

              {directs.length > 0 && (
                <section className="chat-group">
                  <h2>Direct</h2>
                  {directs.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className={`chat-item${r.unread ? " unread" : ""}`}
                      aria-current={currentRoomId === r.id ? "page" : undefined}
                      onClick={() => selectRoom(r.id)}
                    >
                      <span className="chat-title">
                        <span>{r.title}</span>
                      </span>
                      <time className="chat-when">{formatWhen(r.lastAt)}</time>
                      {r.preview && <span className="chat-preview">{r.preview}</span>}
                    </button>
                  ))}
                </section>
              )}

              {localSessions.length > 0 && (
                <section className="chat-group">
                  <h2>Local sessions</h2>
                  {localSessions.slice(0, 12).map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="chat-item"
                      onClick={() => onOpenSession(s.sessionId)}
                    >
                      <span className="chat-title">
                        <span>{s.asked || s.title}</span>
                        {s.source && <span className="chat-tag">{s.source}</span>}
                      </span>
                      <time className="chat-when">{formatWhen(s.at)}</time>
                      {s.project && <span className="chat-preview">{s.project}</span>}
                    </button>
                  ))}
                </section>
              )}
            </nav>
          </div>

          <section className="chat-integrations" aria-label="Connections">
            <h2>Connections</h2>
            <button type="button" className="chat-int-btn" onClick={() => void openIntegration("board")}>
              + Add a Vercel Board
            </button>
            <button type="button" className="chat-int-btn" onClick={() => void openIntegration("slack")}>
              + Add Slack
            </button>
          </section>
        </aside>

        <main className="chat-room">
          {currentRoomId ? (
            <section className="chat-conversation">
              <header className="chat-room-head">
                <button
                  type="button"
                  className="chat-rooms-back"
                  onClick={() => {
                    window.location.hash = "";
                    setCurrentRoomId(null);
                  }}
                >
                  ← Rooms
                </button>
                <h1>{currentRoom?.title || currentRoomId}</h1>
                <span className="chat-sub">
                  {!currentRoom
                    ? "Linked discussion"
                    : currentRoom.askTarget
                      ? `Direct with ${currentRoom.askTarget.name}`
                      : currentRoom.board
                        ? "Vercel Board channel"
                        : currentRoom.kind === "direct"
                          ? "Direct room"
                          : "Channel"}
                </span>
              </header>

              <div className="chat-log" ref={logRef} tabIndex={0} role="region" aria-label="Messages">
                {logNotice && <p className="chat-quiet">{logNotice}</p>}
                {messages.map((m) => (
                  <article key={m.id} className={`chat-msg${m.mine ? " mine" : ""}`}>
                    <div className="chat-who">
                      <span>{m.name}</span>
                      <time dateTime={new Date(m.at).toISOString()}>{formatWhen(m.at)}</time>
                    </div>
                    <div className="chat-body">{m.body}</div>
                  </article>
                ))}
              </div>

              <form className="chat-composer" onSubmit={handleSend}>
                {sendError && <p className="chat-error" role="alert">{sendError}</p>}
                <div className="chat-composer-box">
                  <textarea
                    rows={2}
                    value={draft}
                    disabled={!canSend || sending}
                    placeholder={
                      canSend
                        ? `Message ${currentRoom?.title || "room"}…`
                        : status?.why
                          ? `Reading only: ${status.why}`
                          : "Reading only while Scout runtime is offline"
                    }
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void handleSend(e);
                      }
                    }}
                  />
                  <button type="submit" className="chat-send" disabled={!canSend || !draft.trim() || sending}>
                    {sending ? "Sending…" : "Send"}
                  </button>
                </div>
              </form>
            </section>
          ) : (
            <div className="chat-empty">
              <h1>{rooms && rooms.length > 0 ? "Choose a room" : "Scout Chat"}</h1>
              <p>
                {rooms && rooms.length > 0
                  ? "Open a channel or direct conversation from the list, or inspect any local agent session thread."
                  : localSessions.length > 0
                    ? "Select a local session thread from the sidebar to read its full transcript, or start Scout's runtime for live rooms."
                    : "Start Scout's runtime to connect channels, direct agent conversations, and Vercel Board rooms."}
              </p>
              {canSend && targets.length > 0 && (
                <button
                  type="button"
                  className="chat-primary-btn"
                  onClick={() => {
                    setAskTargetId(targets.length === 1 ? targets[0].id : "");
                    setAskOpen(true);
                  }}
                >
                  Ask an agent
                </button>
              )}
            </div>
          )}
        </main>
      </div>

      {askOpen && (
        <div className="chat-modal-backdrop" onClick={() => setAskOpen(false)}>
          <div className="chat-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Ask an agent">
            <header className="chat-modal-head">
              <h2>Ask an agent</h2>
              <button type="button" onClick={() => setAskOpen(false)}>Close</button>
            </header>
            <form className="chat-modal-form" onSubmit={handleFirstAsk}>
              <label>
                <span>Agent</span>
                <select value={askTargetId} onChange={(e) => setAskTargetId(e.target.value)} required>
                  <option value="">Choose an agent</option>
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Message</span>
                <textarea rows={3} value={askText} onChange={(e) => setAskText(e.target.value)} required />
              </label>
              {sendError && <p className="chat-error">{sendError}</p>}
              <button type="submit" className="chat-primary-btn" disabled={sending || !askTargetId || !askText.trim()}>
                {sending ? "Sending…" : "Send ask"}
              </button>
            </form>
          </div>
        </div>
      )}

      {integrationKind && (
        <div className="chat-modal-backdrop" onClick={() => setIntegrationKind(null)}>
          <div className="chat-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Connect integration">
            <header className="chat-modal-head">
              <h2>{integrationKind === "board" ? "Add a Vercel Board" : "Add Slack"}</h2>
              <button type="button" onClick={() => setIntegrationKind(null)}>Close</button>
            </header>
            <p className="chat-modal-msg">
              {integrationSupport ? integrationSupport.message || "" : "Checking this host…"}
            </p>
            {integrationSupport?.available && (
              <form className="chat-modal-form" onSubmit={submitIntegration}>
                {integrationKind === "board" ? (
                  <>
                    <label>
                      <span>Team ID, slug, or Board API URL</span>
                      <input name="target" required maxLength={512} />
                    </label>
                    <label>
                      <span>Credential entry name</span>
                      <input name="entry" type="password" autoComplete="off" required maxLength={128} />
                    </label>
                  </>
                ) : (
                  <>
                    <label>
                      <span>Project path</span>
                      <input name="project" required />
                    </label>
                    <label>
                      <span>Agent ID (optional)</span>
                      <input name="agent" maxLength={128} />
                    </label>
                  </>
                )}
                <button type="submit" className="chat-primary-btn">
                  {integrationKind === "board" ? "Connect Board" : "Start Slack setup"}
                </button>
              </form>
            )}
            {integrationResult && <p className="chat-modal-msg">{integrationResult}</p>}
            {integrationSteps.length > 0 && (
              <ol className="chat-modal-steps">
                {integrationSteps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
