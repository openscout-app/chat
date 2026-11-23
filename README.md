# Scout Chat

Your rooms with your agents, on Scout. Channels you share with agents, direct conversations with one agent, and the rooms Scout keeps for a Vercel Board, in one local page. What you write goes through Scout's runtime, in your name.

A direct room is one agent: what you write there wakes it, and its answer comes back to the room. A channel is a room you share; a message there is posted to everyone in it. New messages arrive as they are posted, from any agent, the CLI, or another Scout app.

## Run it

```sh
npx github:openscout-app/chat
```

That's all. It fetches Scout Chat from this repository and opens http://localhost:4802. There is nothing to build. Add `--no-open` to skip the browser, or `--port <n>` for another port. If Scout Chat is already running, the command opens it. If something else holds the port, it takes the next free one.

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

## Connect a Vercel Board

```sh
secret set vercel-board              # store your Vercel access token once
npx github:openscout-app/chat connect board --team <team ID or slug> --credential secret_cli:vercel-board
```

Scout follows the Board's channels. Each one becomes a room here, marked Board. When you claim a Board task for an agent, Scout turns it into an ask, and the agent's answer goes back to the Board as the task's result. Board text is quoted as source material; it never routes work by itself. The token stays in your keychain: the command names where it is stored, never the token. `scout integration status vercel-board` shows the connection.

This uses `scout integration connect vercel-board`, which needs Scout 0.5.4 or newer.

## Connect Slack

```sh
npx github:openscout-app/chat connect slack --project <path to a project>
```

This starts Slack setup for that project's agent and prints the steps that follow: create the Slack app from the manifest Scout gives you (Socket Mode), store its two tokens with `secret set`, name who may talk to it, then verify and start. Mentions of the app and direct messages then reach the agent, and each Slack thread stays one conversation. `scout integration status <operation>` always says which step is next.

Slack also needs Scout's Slack companion on the host, which carries Slack's events to the runtime. It isn't published with Scout yet, so a Scout installed from npm stops at the verify step and says the companion is missing.

## Posting in your name

Reading needs nothing. Posting needs the operator key that `scout setup` creates: a file only you can read, in Scout's support folder (`~/Library/Application Support/OpenScout/runtime/operator-attribution.key` on macOS; `OPENSCOUT_ATTRIBUTION_KEY_FILE` names another). Scout Chat reads it once at start and signs each post the way the runtime checks them, so the runtime records the message as yours. The key never leaves the process. Scout 0.5.4 or newer makes the key; an older Scout has none, and Scout Chat then opens read-only and says why.

The server listens on 127.0.0.1 only. It takes a post only from its own page: the Host must be this server and the Origin must match. Another site, or a name pointed at 127.0.0.1, can't post through it.

## How it finds Scout

Scout Chat finds the runtime the way Scout's own tools do: `SCOUT_RUNTIME_URL` or `OPENSCOUT_BROKER_URL` if set, else the host and port in `~/.openscout/config.json`, else `127.0.0.1:43110`. It reads rooms from `/v1/conversation-projection`, messages from `/v1/messages`, and follows `/v1/events/stream` for new ones. A post in a direct room goes to `/v1/deliver` as a consult to its agent; a post in a channel goes to `/v1/messages`. Sessions Scout only observes, such as a Claude Code transcript, are not rooms and don't appear.

`npx github:openscout-app/chat status` says whether the runtime is up, whether Chat can post in your name, and which Board connections exist.

## License

Apache-2.0
