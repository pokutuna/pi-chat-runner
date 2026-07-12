# gc-logging-agent

Extends the pi-chat-runner base image with a single `FROM` step, specialized for Google Cloud Logging investigation.

- CLI: `gcloud` / `duckdb` / `uv` (`uvx`)
- Skills:
  - [`skills/investigate-logging`](skills/investigate-logging/SKILL.md) — fetch logs via `gcloud logging read`, analyze with jq/duckdb
  - [`skills/uv-pep723`](skills/uv-pep723/SKILL.md) — write self-contained Python scripts with `uv run --script` for analysis beyond jq/duckdb
- pi extension: [`extensions/init-gcloud.ts`](extensions/init-gcloud.ts) — on each pi process start, points `gcloud` at the mounted `GOOGLE_APPLICATION_CREDENTIALS` (`auth/credential_file_override`) and sets the default project, so the agent never has to run `gcloud auth`/`gcloud config` itself
- Config: a mention-triggered channel using the investigation prompt

See [docs/design/session-runtime.md §5](../../docs/design/session-runtime.md) for the image-layering convention this follows (`FROM` one step + skills/extensions under `$AGENT_HOME/.pi/agent/`).

## Build

The Dockerfile's `BASE_IMAGE` defaults to the published base image
(`ghcr.io/pokutuna/pi-chat-runner:latest`), so this example builds standalone
— no need to clone the repo or build the base image yourself (the image is
`linux/amd64` only; add `--platform linux/amd64` on Apple Silicon):

```sh
docker build -t gc-logging-agent:local examples/gc-logging-agent
```

To build against a locally-built base image instead (e.g. while developing
pi-chat-runner itself), override `BASE_IMAGE`:

```sh
# from the repo root: base image
docker build -t pi-chat-runner:local .

# this extension image
docker build -t gc-logging-agent:local --build-arg BASE_IMAGE=pi-chat-runner:local examples/gc-logging-agent
```

## Run locally

Assumes Slack Socket Mode + Vertex AI (same variables as `examples/config`), plus `GOOGLE_CLOUD_PROJECT` and `GOOGLE_APPLICATION_CREDENTIALS` (a service account key, or the default ADC path after `gcloud auth application-default login`).

```sh
cd examples/gc-logging-agent
cp .env.example .env  # fill in the values

docker compose up -d
docker compose logs -f
docker compose down
```

`compose.yaml` mounts `config/` over `/app/examples/config`, mounts the host's `GOOGLE_APPLICATION_CREDENTIALS` file at the same path inside the container, and keeps the workdir (session transcripts) in a named volume so it survives container restarts.

## Verified

- `docker build` succeeds for the base → extension two-stage build
- `gcloud --version` / `duckdb --version` / `uv --version` run as both root and agent (uid 1001)
- The `investigate-logging` skill lands under pi's default discovery path (`/home/agent/.pi/agent/skills/`) and pi picks it up at startup
