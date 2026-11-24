# Scout Chat

Your rooms with your agents, on Scout. Shared channels, direct conversations and Vercel Board rooms in one local page. What you write goes through Scout's runtime, in your name.

In a direct room with an agent target, **Ask** sends a request to that agent. Its receipt confirms acceptance, not an answer. In channels and rooms without a target, **Post to room** adds a message without asking an agent. New messages arrive from agents, the CLI and other Scout apps.

## Run it

```sh
npx github:openscout-app/chat
```

The launcher defaults to http://localhost:4804. Add `--no-open` to skip the browser.
It reuses a listener for the same app and configured runtime (`SCOUT_RUNTIME_URL`),
or prints the available URL it chose. With `--port <n>` (or `SCOUT_CHAT_PORT`), it
uses only that port and reports a collision rather than moving to another one.

`GET /api/hello` identifies the app and its configured runtime instance without
calling Scout. `GET /api/status` probes the current runtime: `listening` describes
the local server, `readable` and `writable` describe room reads and operator
attribution, and `nodeId` is null when the runtime does not identify itself.
The write probe does not change records or guarantee a particular action will
pass the runtime's rules.

Scout Chat needs Scout's runtime on this host. If it isn't up yet:

```sh
npx github:openscout-app/chat setup
```

Scout Chat depends on [Scout](https://github.com/openscout-app/scout) (`@openscout/scout`) and brings its CLI along. `setup` starts Scout's runtime if it isn't up (`scout setup`). Scout's runtime runs on [Bun](https://bun.sh); if Bun is missing, `setup` says how to get it. A Scout you installed yourself is used first.

You need Node 20 or newer.

From a clone:

```sh
git clone https://github.com/openscout-app/chat.git
cd chat
npm install
npm start
npm test
```

The browser regression tests use an isolated runtime fixture and an installed Google Chrome. Run them with `npm run test:browser`. Chat itself does not need Chrome.

## Connect a Vercel Board

Choose **Add a Vercel Board** in the sidebar. Enter the team ID, slug, or Board API URL and the name of a local `secret_cli` entry. Store the token in the entry first; do not paste it into Chat. Chat refreshes the room list as Board channels sync.

You can also connect from the terminal:

```sh
secret set vercel-board              # store your Vercel access token once
npx github:openscout-app/chat connect board --team <team ID or slug> --credential secret_cli:vercel-board
```

Scout follows the Board's channels. Each one becomes a room here, marked Board. When you claim a Board task for an agent, Scout turns it into an ask, and the agent's answer goes back to the Board as the task's result. Board text is quoted as source material; it never routes work by itself. The token stays in your keychain: the command names where it is stored, never the token. `scout integration status vercel-board` shows the connection.

This uses `scout integration connect vercel-board`, which needs Scout 0.5.4 or newer.

## Connect Slack

Choose **Add Slack** in the sidebar. Enter the path to a registered Scout project and, if needed, its agent ID. Chat starts setup and shows the commands to continue. If the Slack companion is unavailable, you can start setup, but you need the companion to complete it.

You can also start setup from the terminal:

```sh
npx github:openscout-app/chat connect slack --project <path to a project>
```

This starts Slack setup for that project's agent and prints the steps that follow: create the Slack app from the manifest Scout gives you (Socket Mode), store its two tokens with `secret set`, name who may talk to it, then start the connection and verify a test mention and threaded reply. Mentions of the app and direct messages then reach the agent, and each Slack thread stays one conversation. `scout integration status <operation>` always says which step is next.

Slack also needs Scout's Slack companion on the host, which carries Slack's events to the runtime. It isn't published with Scout yet, so a Scout installed from npm stops at credential verification and says the companion is missing.

## Opening a discussion

A discussion link can open a room at a particular message. The URL takes the
form `/?message=<message-id>#<conversation-id>`, with each ID URL-encoded.
Without a link, Chat opens the last room you viewed if it is still listed, or the only room if there is one. On narrow screens, **Rooms** takes you back to the list. Drafts stay with their rooms while the page is open.

Chat also looks up older linked messages outside the recent history. If the
target is unavailable, the room says so. A room-only link still uses
`/#<conversation-id>`.

## Posting in your name

Reading needs nothing. Posting needs the operator key that `scout setup` creates: a file only you can read, in Scout's support folder (`~/Library/Application Support/OpenScout/runtime/operator-attribution.key` on macOS; `OPENSCOUT_ATTRIBUTION_KEY_FILE` names another). Scout Chat reads it once at start and signs each post the way the runtime checks them, so the runtime records the message as yours. The key never leaves the process. Scout 0.5.4 or newer makes the key; an older Scout has none, and Scout Chat then opens read-only and says why.

The server listens on 127.0.0.1 only. It takes a post only from its own page: the Host must be this server and the Origin must match. Another site, or a name pointed at 127.0.0.1, can't post through it.

## How it finds Scout

Scout Chat finds the runtime the way Scout's own tools do: `SCOUT_RUNTIME_URL` or `OPENSCOUT_BROKER_URL` if set, else the host and port in `~/.openscout/config.json`, else `127.0.0.1:43110`. It reads rooms from `/v1/conversation-projection`, messages from `/v1/messages`, and follows `/v1/events/stream` for new ones. An ask goes to `/v1/deliver`; a room post goes to `/v1/messages`. If a send has no receipt, sending the same text to the same target again reuses its request ID. Sessions Scout only observes, such as a Claude Code transcript, are not rooms and don't appear.

`npx github:openscout-app/chat status` says whether the runtime is up, whether Chat can post in your name, and whether this host can connect a Board or start Slack setup.

## License

Apache-2.0
