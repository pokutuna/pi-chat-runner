---
name: investigate-logging
description: Fetch Google Cloud Logging via gcloud logging read and analyze with jq/duckdb. Use for "investigate Cloud Logging", "GKE/Cloud Run log investigation", "find the cause of a production error".
allowed-tools: bash(timeout *) bash(gcloud logging *) bash(jq *) bash(duckdb *)
---

# Cloud Logging Investigation

GOOGLE_CLOUD_PROJECT (env) is the default project ID. If the user names a different project, override it with `--project`.

## Principles

1. **Check existence first** — don't fire a large query right away; confirm count and structure with a few records
2. **Write to a file** — save to `/tmp/logs.json` etc. instead of piping directly, then run jq/duckdb repeatedly
3. **Filter on indexed fields** — prefer `resource.type` / `logName` / `timestamp` / `severity`
4. **Always set a timeout** — don't wait forever on a query with no results

## Basic command

```bash
timeout 60 gcloud logging read 'FILTER' \
  --project "${GOOGLE_CLOUD_PROJECT}" \
  --freshness 1h \
  --limit 100 \
  --format json
```

### Indexed fields (fast)

`resource.type`, `resource.labels.*`, `logName`, `severity`, `timestamp`, `httpRequest.status`, `labels.*`, `trace`

### Filter syntax

```
field="value"          exact match
field:substring         substring match (slow)
severity>=ERROR
expr1 AND expr2         uses index
expr1 OR expr2          does not use index (slow)
timestamp>="2024-01-01T00:00:00Z"
```

## Workflow

### 1. Check existence and structure

```bash
timeout 30 gcloud logging read 'resource.type="cloud_run_revision"' \
  --project "${GOOGLE_CLOUD_PROJECT}" --freshness 1h --limit 3 --format json | jq 'length'

timeout 30 gcloud logging read 'resource.type="cloud_run_revision"' \
  --project "${GOOGLE_CLOUD_PROJECT}" --freshness 1h --limit 1 --format json | jq '.[0]'
```

If nothing comes back, suspect the filter, project, or time range.

### 2. Write to a file and analyze

```bash
timeout 120 gcloud logging read 'FILTER' \
  --project "${GOOGLE_CLOUD_PROJECT}" --freshness 7d --limit 1000 --format json > /tmp/logs.json

jq length /tmp/logs.json
```

### 3. Format with jq filters

Presets live in `scripts/filters/` (paths relative to this SKILL.md):

| Filter | Purpose |
|---|---|
| `minimal.jq` | Overview (timestamp/severity/resource/message) |
| `http-request.jq` | HTTP request detail (method/url/status/latency) |
| `latency.jq` | Sorted by latency, descending |
| `error-analysis.jq` | Error investigation (message/stack/trace) |
| `trace.jq` | Trace investigation (sorted chronologically) |

```bash
jq -f scripts/filters/minimal.jq /tmp/logs.json
```

### 4. Aggregate with duckdb

```bash
duckdb -s "SELECT severity, COUNT(*) FROM read_json('/tmp/logs.json') GROUP BY 1 ORDER BY 2 DESC"

# p50/p95/p99 latency (httpRequest.latency is a string like "0.123s", so cast it)
duckdb -s "
  SELECT
    quantile_cont(CAST(rtrim(\"httpRequest\".latency, 's') AS DOUBLE), 0.5) AS p50,
    quantile_cont(CAST(rtrim(\"httpRequest\".latency, 's') AS DOUBLE), 0.95) AS p95,
    quantile_cont(CAST(rtrim(\"httpRequest\".latency, 's') AS DOUBLE), 0.99) AS p99
  FROM read_json('/tmp/logs.json')
  WHERE \"httpRequest\".latency IS NOT NULL
"
```

## Common filters

```
resource.type="cloud_run_revision"
resource.type="k8s_container"
severity>=ERROR
httpRequest.status>=500
httpRequest.latency>="250ms"
trace="projects/PROJECT_ID/traces/TRACE_ID"
```

## Troubleshooting

- **DEADLINE_EXCEEDED**: filter too broad → narrow `--freshness` / `--limit`, use indexed fields
- **0 results**: check existence without a filter; suspect project, time range, or Log Router exclusions
- **auth error**: ADC not set up in the container. Check `GOOGLE_APPLICATION_CREDENTIALS`
