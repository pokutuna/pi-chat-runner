# smart-fetch-agent

Extends the pi-chat-runner base image with a single `FROM` step, adding the
[`pi-smart-fetch`](https://www.npmjs.com/package/pi-smart-fetch) extension
(URL fetch + summarize) for one channel only.

- pi extension: `pi-smart-fetch` (installed as an npm dependency into
  `/app/node_modules`, not a local file under `extensions/`)
- Config: a mention-triggered `default` channel with no extensions, plus one
  test channel where `pi-smart-fetch` is enabled

## Why per-channel `extensions:`, not `.pi/agent/extensions/` auto-discovery

pi auto-discovers anything placed under `$AGENT_HOME/.pi/agent/extensions/`
and applies it to **every** channel (see
[docs/design/session-runtime.md §5](../../docs/design/session-runtime.md)
and `gc-logging-agent`'s `extensions/init-gcloud.ts` for that pattern).

This example deliberately does the opposite: `pi-smart-fetch` is listed in
`config/agent.yaml`'s `channels[].extensions` for one specific channel
(`C0000000001`), and the `default` channel has no `extensions:` entry at all.
The extension's file lives at `/app/node_modules/pi-smart-fetch/dist/index.js`
— outside `$AGENT_HOME/.pi/agent/extensions/` — precisely so it is *not*
auto-discovered, and only channels that explicitly reference its path get it.
This is the right shape when a capability (and its cost — see below) should
only apply to a channel that actually needs it, rather than to every channel
the bot is in.

The runner (`src/session/runner.ts`) automatically adds each `extensions:`
path's dirname to `--allow-fs-read` at kick time, so no extra filesystem
permission wiring is needed here. `/app/node_modules/pi-smart-fetch/dist/`
is also already covered by the base image's own Permission Model config
(the whole `/app/node_modules` tree is readable), so nothing has to be added
for this example either.

## Alternative: install into `$AGENT_HOME` with `pi install` (all channels)

The Dockerfile in this example installs `pi-smart-fetch` into `/app/node_modules`
so it stays out of pi's auto-discovery path and only the channel that lists it
in `extensions:` gets it. If you instead want the extension available to
**every** channel, and you'd rather not learn this repo's `/app` vs.
`$AGENT_HOME` layout at all, pi's own `install` command does this with zero
pi-chat-runner-specific knowledge:

```dockerfile
ARG BASE_IMAGE=ghcr.io/pokutuna/pi-chat-runner:latest
FROM ${BASE_IMAGE}

USER agent
RUN /app/node_modules/.bin/pi install npm:pi-smart-fetch
USER root
```

`USER agent` switches to the uid-1001 user baked into the base image (see the
base `Dockerfile`) before running `pi install`, so the package lands owned by
`agent:agent` under `$AGENT_HOME/.pi/agent/npm/node_modules/` with no `chown`
step needed, and gets registered in `$AGENT_HOME/.pi/agent/settings.json`'s
`packages` list — the same mechanism `pi install` uses outside this runner.
Because this path *is* pi's auto-discovery path, no `channels[].extensions`
entry is needed at all; every channel picks it up automatically. This trades
away the per-channel scoping (and its cost containment) this example
otherwise demonstrates — use it only when every channel the bot serves should
have the capability (and its `allowAddons` cost — see below).

## Why `agent.runtime.allowAddons` is needed

`pi-smart-fetch` depends on a native addon (`wreq-js`, a Rust N-API binary).
Node's Permission Model (`--permission`, on by default for the pi child
process — see `docs/design/config.md` §6) rejects loading native addons
(`.node` files) unless `--allow-addons` is passed. `pi-smart-fetch` would
otherwise fail to load under this runner.

`agent.runtime.allowAddons` (default `false` across the repo) is the opt-in
for this: setting it `true` adds `--allow-addons` to the pi child process's
flags (env override: `PI_ALLOW_ADDONS`). This example sets its default to
`true` in `config/agent.yaml`, since enabling `pi-smart-fetch` is the whole
point of this example — unlike `examples/config/agent.yaml`, where it
defaults to `false` because no channel there needs it.

**Trade-off**: enabling `--allow-addons` loosens part of the Permission Model
isolation layer — native code can bypass this layer's own fs-access checks
(uid separation between the runner and the spawned pi process still holds
regardless). Only enable it for images that actually load a native-addon
extension, and only for the channels that need it.

## Build

The Dockerfile's `BASE_IMAGE` defaults to the published base image
(`ghcr.io/pokutuna/pi-chat-runner:latest`), so this example builds standalone
— no need to clone the repo or build the base image yourself (the image is
`linux/amd64` only; add `--platform linux/amd64` on Apple Silicon):

```sh
docker build -t smart-fetch-agent:local examples/smart-fetch-agent
```

To build against a locally-built base image instead (e.g. while developing
pi-chat-runner itself), override `BASE_IMAGE`:

```sh
# from the repo root: base image
docker build -t pi-chat-runner:local .

# this extension image
docker build -t smart-fetch-agent:local --build-arg BASE_IMAGE=pi-chat-runner:local examples/smart-fetch-agent
```

## Run locally

Assumes Slack Socket Mode + Vertex AI (same variables as `examples/config`),
plus `GOOGLE_CLOUD_PROJECT` and `GOOGLE_APPLICATION_CREDENTIALS` (a service
account key, or the default ADC path after
`gcloud auth application-default login`).

```sh
cd examples/smart-fetch-agent
cp .env.example .env  # fill in the values

docker compose up -d
docker compose logs -f
docker compose down
```

`compose.yaml` mounts `config/` over `/app/examples/config`, mounts the
host's `GOOGLE_APPLICATION_CREDENTIALS` file at the same path inside the
container, and keeps the workdir (session transcripts) in a named volume so
it survives container restarts.
