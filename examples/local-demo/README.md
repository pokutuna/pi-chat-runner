# local-demo

A ready-to-run tour of pi-chat-runner's features in the local REPL
(`pnpm run dev:local`) — no Slack App, no tokens, just model credentials.
[`agent.yaml`](agent.yaml) defines five channels, each showing a different
trigger/session/tooling shape:

| channel  | trigger                               | what it demonstrates |
|----------|---------------------------------------|----------------------|
| `local`  | mention                               | the plain `@bot` assistant (REPL default channel) |
| `notes`  | passthrough (every post)              | `session.mode: channel` (one ongoing session), flat replies |
| `alerts` | mention (human) / keyword (bot) / reaction | gate composition + `allowBots`, debounce + channel affinity, `memory: false`, read-only `tools` |
| `links`  | URL keyword or mention                | per-channel extension (`pi-smart-fetch`) |
| `dm`     | passthrough                           | DM opt-in (`!dm on`) |

Memory (the shared `../shared/` area) is enabled globally via `SHARED_DIR` and
opted out only on `alerts`.

## Setup

Nothing demo-specific goes into your environment: credentials and
machine-specific paths live in `.env.local` (gitignored) as for any
`dev:local` run, and the demo itself is selected on the command line.

`.env.local`, for the default `google-vertex` model (ADC):

```sh
GOOGLE_CLOUD_PROJECT=<your project>
GOOGLE_CLOUD_LOCATION=<region, or "global">

# The pi child process runs with HOME remapped to PI_AGENT_HOME (default
# /home/agent), so ADC needs an explicit absolute path and PI_AGENT_HOME a
# writable directory. On macOS write /tmp paths as /private/tmp (its
# realpath) — the Permission Model compares realpaths.
GOOGLE_APPLICATION_CREDENTIALS=<absolute path to application_default_credentials.json>
PI_AGENT_HOME=<writable dir, e.g. /private/tmp/pi-chat-runner/home>
```

To use another provider instead, change `default.model` in `agent.yaml` (pi's
canonical `provider/model-id[:thinking-level]` form) and forward its API key
via `agent.env` — see the commented block in `agent.yaml` and the
[Configuration](../../README.md#configuration) section of the main README.

Then run the demo — env vars on the command line take precedence over
`.env.local`, so an existing `CONFIG_PATH` there doesn't interfere.
`SHARED_DIR` backs the memory skill ([docs/design/shared.md](../../docs/design/shared.md));
point it at any writable directory:

```sh
pnpm install
mkdir -p <your PI_AGENT_HOME> <your SHARED_DIR>
CONFIG_PATH=examples/local-demo/agent.yaml SHARED_DIR=<writable dir, e.g. /tmp/pi-chat-runner/shared> pnpm run dev:local
```

You get a two-pane TUI: logs on top, chat below, input at the bottom. `!help`
shows the full REPL grammar; `!channels` lists the channels above. To inspect
what a channel's merged config resolves to without starting the REPL:
`CONFIG_PATH=examples/local-demo/agent.yaml pnpm exec tsx src/server.ts dump alerts`.

## Walkthrough

### 1. Mention trigger (`local`)

```
#local you> hello?
#local you> @bot hello! what can you do here?
```

The bare message is dropped by the gate (watch the log pane for the gate
decision); the mention kicks a session and the reply arrives as a thread
(`[N]↳M`). Follow up in the thread with `>N more text` — it resumes the same
session with context intact.

### 2. Channel-as-session (`notes`)

```
#local you> !channel notes
#notes you> TIL: zod .strict() rejects unknown keys
#notes you> also: tsdown does the dual-format build for free
#notes you> what did I note about zod?
```

Every post triggers (passthrough, no mention). All three land in one session
(`session.mode: channel`), so the last question is answered from the earlier
notes. Replies come back at channel level (`reply.mode: flat`), not as
threads. `/new` cuts the session: send `/new`, then ask again — the context
is gone (but see memory below).

### 3. Gate composition + alert triage (`alerts`)

```
#notes you> !channel alerts
#alerts you> ALERT: disk usage 95% on db-01
#alerts you> !user monitor --bot
#alerts monitor> ALERT: disk usage 95% on db-01
#alerts monitor> CRITICAL: db-01 not responding
```

The human "ALERT" post does not trigger (humans need a mention); the same
text from a bot sender does (`allowBots` + the `sender`/`keyword` `and`
composition). The two bot alerts arrive within `debounceSec: 5`, so they are
bundled into a single turn — and a later alert within 10 minutes joins the
same session (`affinity.scope: channel`) instead of starting fresh. Also try
`!user you` to switch back, then `!react N eyes` on any earlier message: the
reaction gate starts triage on it. The `tools` allowlist keeps this channel's
agent read-only.

### 4. Per-channel extension (`links`)

Optional — the only channel needing extra installs:

```sh
pnpm add pi-smart-fetch     # provides ../../node_modules/pi-smart-fetch/...
# then restart with PI_ALLOW_ADDONS=1 added to the same command line
# (native addon under the Permission Model)
```

```
#alerts you> !channel links
#links you> https://github.com/earendil-works/pi looks interesting
```

The URL keyword triggers without a mention, and the agent summarizes the page
using the `pi-smart-fetch` tool — which only this channel has (try the same
URL in `#local` with a mention: no fetch tool there). See
[`examples/smart-fetch-agent`](../smart-fetch-agent/) for the same pattern in
a container image.

### 5. DM opt-in (`dm`)

```
#links you> !channel D0LOCAL
#D0LOCAL you> !dm on
#D0LOCAL you> hey, are you there?
```

With `!dm on`, posts carry the DM flag and resolve against the `dm` entry
(passthrough — every DM triggers, no mention needed). Comment out the `dm`
entry in `agent.yaml` and the same input is dropped: DMs are disabled unless
opted in. Channel config is re-read every message, so no restart is needed.

### 6. Memory across sessions

With `SHARED_DIR` set, the memory skill is wired into every channel except
`alerts` (`memory: false`):

```
#local you> @bot remember this: my favorite deploy window is Friday 4pm
#local you> /new
#local you> @bot what's my favorite deploy window?
```

The recall works after `/new` because memory persists outside the session, in
`<SHARED_DIR>/local/` — inspect the files there. In `#alerts`, asking the
agent to remember something has no memory skill to land in.

### Chat commands

Anywhere along the way: `/disable` mutes a channel (triggers silently
dropped), `/enable` recovers, `/new <text>` cuts the session and immediately
kicks a fresh one with that text. In mention-gated channels prefix them:
`@bot /new`.
