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
[docs/design/runtime.md §4.2](../../docs/design/runtime.md)
and `gc-logging-agent`'s `extensions/init-gcloud.ts` for that pattern).

This example deliberately does the opposite: `pi-smart-fetch` is listed in
`config/agent.yaml`'s `channels[].agent.extensions` for one specific channel
(`C0000000001`), and the `default` channel has no `extensions:` entry at all.
The extension's file lives at `/app/node_modules/pi-smart-fetch/dist/index.js`
— outside `$AGENT_HOME/.pi/agent/extensions/` — precisely so it is *not*
auto-discovered, and only channels that explicitly reference its path get it.
This is the right shape when a capability (and its cost) should only apply to
a channel that actually needs it, rather than to every channel the bot is in.

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
Because this path *is* pi's auto-discovery path, no `channels[].agent.extensions`
entry is needed at all; every channel picks it up automatically. This trades
away the per-channel scoping (and its cost containment) this example
otherwise demonstrates — use it only when every channel the bot serves should
have the capability.

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
