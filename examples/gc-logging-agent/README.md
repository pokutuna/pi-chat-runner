# gc-logging-agent

Extends the pi-chat-runner base image with a single `FROM` step, specialized for Google Cloud Logging investigation.

- CLI: `gcloud` / `duckdb` / `uv` (`uvx`)
- Skills:
  - [`skills/investigate-logging`](skills/investigate-logging/SKILL.md) — fetch logs via `gcloud logging read`, analyze with jq/duckdb
  - [`skills/uv-pep723`](skills/uv-pep723/SKILL.md) — write self-contained Python scripts with `uv run --script` for analysis beyond jq/duckdb
- Config: a mention-triggered channel using the investigation prompt

See [docs/design/session-runtime.md §5](../../docs/design/session-runtime.md) for the extension convention this follows (`FROM` one step + skills under `$AGENT_HOME/.pi/agent/skills/`).

## Build

Build the base image first, then build this image on top of it.

```sh
# from the repo root: base image
docker build -t pi-chat-runner:local .

# this extension image
docker build -t gc-logging-agent:local examples/gc-logging-agent
```

## Run locally

Assumes Slack Socket Mode + Vertex AI (same variables as `examples/config`), plus `GOOGLE_CLOUD_PROJECT` and a service account key mounted via `GOOGLE_APPLICATION_CREDENTIALS`.

```sh
docker run --rm \
  -e SLACK_MODE=socket \
  -e SLACK_APP_TOKEN=xapp-... \
  -e SLACK_BOT_TOKEN=xoxb-... \
  -e SLACK_BOT_USER_ID=U... \
  -e GOOGLE_CLOUD_PROJECT=my-gcp-project \
  -e GOOGLE_APPLICATION_CREDENTIALS=/secrets/sa.json \
  -v /path/to/sa.json:/secrets/sa.json:ro \
  -v "$(pwd)/examples/gc-logging-agent/config:/app/examples/config:ro" \
  gc-logging-agent:local
```

`CONFIG_DIR` defaults to `examples/config` (relative path), so this mounts `config/` over `/app/examples/config` inside the container.

## Verified

- `docker build` succeeds for the base → extension two-stage build
- `gcloud --version` / `duckdb --version` / `uv --version` run as both root and agent (uid 1001)
- The `investigate-logging` skill lands under pi's default discovery path (`/home/agent/.pi/agent/skills/`) and pi picks it up at startup
