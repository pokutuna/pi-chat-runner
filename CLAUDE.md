# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A low-cost, serverless runner for running the [pi](https://github.com/earendil-works/pi) coding agent from chat. Currently Slack + Google Cloud (Cloud Run + Firestore + GCS) only.

The design overview is `docs/design.md`; detailed design docs live in `docs/design/`. Code comments reference doc sections (e.g. `session-model.md §4`) — for non-trivial changes, check the referenced section so the implementation matches the documented contract.

## Tech Stack

- Node.js >= 26, TypeScript, ESM (`NodeNext`)
- Hono (HTTP), `@slack/web-api` + `@slack/socket-mode` (no Bolt framework)
- pnpm, tsdown (build), vitest (test), oxlint + oxfmt (lint/format)
- Persistence backends: in-memory / SQLite / Firestore

## Essential Commands

```sh
pnpm test                                          # vitest run (all tests)
pnpm exec vitest run test/dispatch/dispatcher.test.ts # single file
pnpm exec vitest run -t "some test name"           # single test by name
pnpm run typecheck                                 # tsc --noEmit
pnpm run lint                                      # oxlint . && oxfmt --check .
pnpm run dev:socket                                # local dev, Slack Socket Mode (.env.socket)
pnpm run dev:local                                 # local dev, stdin/stdout REPL, no Slack (.env.local)
```

After editing a file, run `pnpm exec oxfmt --write <file>` — oxfmt enforces 2-space indentation and import order, and a plain edit commonly leaves unsorted exports.

The Firestore backend's tests need a live emulator (`FIRESTORE_EMULATOR_HOST`) and skip otherwise. `test/state/control/contract.ts` is a shared contract suite parameterized across backends — add new backend behavior there, not per-backend.

## Architecture

One pipeline, top to bottom; each stage only knows the interface of its neighbor, not which implementation is behind it:

```
Chat (Slack / local)
    │  raw event
    ▼
Ingress            — receives, normalizes to ChatEvent, absorbs duplicates, resolves users (src/ingress/)
    │  ChatEvent
    ▼
Gate               — decides whether to trigger a session (src/gate/)
    │  ChatEvent (accepted only)
    ▼
Inbox              — durable, dedupe'd queue of accepted events (src/state/control/)
    │  InboxItem
    ▼
Dispatcher         — picks the session, acquires the lease, drains the inbox, starts/resumes it (src/dispatch/)
    │  turn input
    ▼
Session / Runtime  — drives the turn; prepares the workdir and spawns/drives the pi child process via RPC (src/session/, src/runtime/)
    │  reply(thread_key, text, files?)
    ▼
Egress             — resolves thread_key to destination, formats (mrkdwn for Slack), chunks (src/egress/)
    │  outgoing message
    ▼
Chat
```

`src/runner.ts` + `src/server.ts` form the composition root. `server.ts` is the CLI entry: it reads System Config and picks the implementations (chat platform, Control State backend, Agent State shelves, `RuntimeConfig`); `startRunner` wires the pipeline and knows nothing about which chat it is wiring. Concrete implementation selection happens only in `server.ts` — `Dispatcher` and below receive interfaces only. See `docs/design.md`, `docs/design/architecture.md`, and `docs/design/session-model.md` for the full rationale.

Chat-specific code lives behind `ChatPlatform` (`src/chat/platform.ts`) — a bundle of ingress + poster + reactor + userResolver + fetchMessage + mentionFormat + formatter. `createSlackPlatform` (`src/chat/slack.ts`) and `createLocalPlatform` (`src/chat/local/`) are the two implementations; nothing outside `src/chat/slack.ts` and `src/ingress/slack/` may import `@slack/*`.

Several directories split a platform-neutral interface from its implementation on purpose (`src/ingress/` vs `src/ingress/slack/`, `src/egress/turn-reactor.ts` vs `src/egress/emoji-turn-reactor.ts`, `src/state/control/` vs `src/state/agent/`, `src/gate/gate.ts` vs `src/gate/gates/`). Match that granularity when extending them — see `docs/design/architecture.md §4` for how the store split was decided.
