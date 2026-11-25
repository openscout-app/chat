import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  ScoutAppFrame,
  StandaloneRecordRouter,
  navigateBrowser,
  useScoutThinHost,
  type ScoutThinStatusBase,
} from "scout-app/shell";
import "scout-app/shell.css";
import { ChatApp } from "./ChatApp";
import "./app.css";

interface ChatHostStatus extends ScoutThinStatusBase {
  localSessions: number;
}

function StandaloneChatApp() {
  const { status, installing, runSetup } = useScoutThinHost<ChatHostStatus>({
    statusPath: "/api/host-status",
  });

  const badge = !status
    ? { label: "Checking Scout", tone: "loading" as const }
    : status.runtimeUp
      ? { label: "Runtime connected", tone: "ready" as const, detail: status.runtimeUrl }
      : {
          label: `Local sessions · ${status.localSessions}`,
          tone: "local" as const,
          detail: "Scout runtime not running",
        };

  const callout =
    status && !status.runtimeUp
      ? {
          title: "Scout runtime is not running yet.",
          description:
            "Browse local agent session threads below, or start Scout's runtime for live channels, direct rooms, and Vercel Board sync.",
          command: "npx openscout-app/chat setup",
          actionLabel: installing ? "Starting…" : "Start runtime",
          onAction: installing ? undefined : () => void runSetup(),
        }
      : null;

  return (
    <ScoutAppFrame
      product="Chat"
      variant="chat"
      rail="full"
      status={badge}
      setupCallout={callout}
    >
      <StandaloneRecordRouter product="Chat" rail="wide" navigate={navigateBrowser}>
        <ChatApp
          runtimeUp={status?.runtimeUp ?? null}
          onOpenSession={(sessionId) => navigateBrowser(`/sessions/${encodeURIComponent(sessionId)}`)}
        />
      </StandaloneRecordRouter>
    </ScoutAppFrame>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StandaloneChatApp />
  </StrictMode>,
);
