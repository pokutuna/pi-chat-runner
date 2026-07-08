# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A low-cost, serverless runner for running the [pi](https://github.com/earendil-works/pi) coding agent from chat. Currently Slack + Google Cloud (Cloud Run + Firestore + GCS) only.

Full design docs live in `docs/design/` (start at `docs/design/README.md`). Roadmap and status: `docs/build-plan.md`. Code comments reference doc sections (e.g. `session-model.md §4`) — for non-trivial changes, check the referenced section so the implementation matches the documented contract.

## Tech Stack

- Node.js >= 26, TypeScript, ESM (`NodeNext`)
- Hono (HTTP), `@slack/web-api` + `@slack/socket-mode` (no Bolt framework)
- pnpm, tsdown (build), vitest (test), biome (lint/format)
- Persistence backends: in-memory / SQLite / Firestore

## Essential Commands

```sh
pnpm test                                          # vitest run (all tests)
pnpm exec vitest run test/session/runner.test.ts   # single file
pnpm exec vitest run -t "some test name"           # single test by name
pnpm run typecheck                                 # tsc --noEmit
pnpm run lint                                      # biome check .
pnpm run dev:socket                                # local dev, Slack Socket Mode (.env.socket)
```

After editing a file, run `pnpm exec biome check --write <file>` — biome enforces tabs and import order, and a plain edit commonly leaves 2-space indentation or unsorted exports.

`STORE_BACKEND=firestore` tests need a live emulator (`FIRESTORE_EMULATOR_HOST`) and skip otherwise. `test/store/state/contract.ts` is a shared contract suite parameterized across backends — add new backend behavior there, not per-backend.

## Architecture

One pipeline, top to bottom; each stage only knows the interface of its neighbor, not which implementation is behind it:

```
Chat (e.g. Slack)
    │  ChatEvent
    ▼
EventSource        — receives raw events, normalizes to ChatEvent (src/ingress/)
    │  ChatEvent
    ▼
Gate               — decides whether to trigger a session (src/gate/)
    │  ChatEvent (accepted only)
    ▼
InboxStore         — durable, dedupe'd queue of accepted events (src/store/state/)
    │  InboxItem
    ▼
SessionRunner      — acquires lease, drains inbox, kicks a turn (src/session/runner.ts)
    │  turn input
    ▼
SessionRuntime     — spawns and drives the pi child process via RPC (src/session/runtime.ts)
    │  reply(thread_key, text, files?)
    ▼
Egress             — resolves thread_key to destination, formats to mrkdwn, chunks (src/egress/)
    │  outgoing message
    ▼
Chat (e.g. Slack)
```

`src/server.ts` + `src/bridge.ts` form the composition root: they read env vars, pick concrete backends (EventSource mode, store backend, workdir archival), and wire everything together. Concrete backend selection happens only there — `SessionRunner` and below receive interfaces only. See `docs/design/architecture.md` and `docs/design/components.md` for the full rationale.

Several directories split a platform-neutral interface from its implementation on purpose (`src/ingress/` vs `src/ingress/slack/`, `src/store/state/` vs `src/store/workdir.ts`, `src/gate/gate.ts` vs `src/gate/gates/`). Match that granularity when extending them — see `docs/design/persistence.md §0` for how the store split was decided.
