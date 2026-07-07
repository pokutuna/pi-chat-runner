# pi-chat-runner

A low-cost, serverless runner for running the [pi](https://github.com/earendil-works/pi) coding agent from chat.

See [docs/design/README.md](docs/design/README.md) for the design and [docs/build-plan.md](docs/build-plan.md) for the roadmap.

## Overview

- The session boundary is a `thread_key`, a conversation scope determined by config
- The agent replies only through the `reply` tool; the host owns the actual destination
- Per-channel trigger conditions, prompts, and models are declared in YAML
- DB (inbox/session/lease) and workdir archival are independent, swappable backends
- The pi agent itself is customized by consumers: extend the base image with your own Dockerfile to add commands or skills (`/app/skills/`, etc.)

## Components

```
Chat (e.g. Slack)
│  ChatEvent
▼
EventSource: receives raw events, normalizes to ChatEvent
│  ChatEvent
▼
Gate: decides whether to trigger a session
│  ChatEvent (accepted only)
▼
InboxStore: durable, dedupe'd queue of accepted events
│  InboxItem
▼
SessionRunner: acquires lease, drains inbox, kicks a turn
│                └─ Store: SessionStore / LeaseStore / WorkdirStorage
│                   decides new vs. resume from SessionStore, restores workdir accordingly
│  turn input
▼
SessionRuntime: spawns and drives pi via RPC (pi)
│  reply(thread_key, text)
▼
Reply Router: resolves thread_key to actual destination
│  outgoing message
▼
Chat (e.g. Slack)
```

| Directory | Role |
|---|---|
| `src/ingress/` | Platform-neutral abstractions + Slack implementation under `slack/` |
| `src/gate/` | Trigger Gate abstraction + implementations under `gates/` |
| `src/config/` | Channel configuration (YAML) loading and schema |
| `src/session/` | Spawning pi, RPC, orchestration |
| `src/store/` | Persistence: `state/` (DB) and `workdir.ts` (workdir archival) |
| `src/reply/` | thread_key resolution and reaction handling |
| `extensions/` | Extensions injected into pi |
| `examples/config/` | Sample channel configuration and prompts |
| `examples/service.yaml` | Cloud Run deployment template (copy and edit) |
| `examples/slack-app-manifest.socket.yaml` | Slack App manifest template, Socket Mode |
| `examples/slack-app-manifest.http.yaml` | Slack App manifest template, Events API |

## Usage

```sh
pnpm install
pnpm run dev:socket   # local dev, Socket Mode
pnpm run dev          # Events API
```

Set Slack credentials in `.env.socket` or `.env`. Channel behavior is configured under `examples/config/channels/*.yaml`:

```yaml
channel: "C0000000001"
systemPrompt: ./prompts/ask-ai.md
trigger:
  combinator: any
  gates:
    - kind: mention
```

DB defaults to InMemory (`./store/sqlite` / `./store/firestore` for persistence). Workdir archival defaults to no-op unless `archiveDir` is set. See [docs/design/persistence.md](docs/design/persistence.md).

```sh
pnpm test
pnpm run typecheck
pnpm run lint
```

## Status

Under active development. Currently Slack and Google Cloud (Cloud Run + Firestore + GCS) only — other chat platforms and cloud providers are not supported yet. Steps 0-5 of [docs/build-plan.md](docs/build-plan.md) are done; Step 6 is partial. CLI (`apply`/`status`/`init`) is not implemented yet.
