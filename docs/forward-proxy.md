# Restricting agent egress with `proxy-chain`

This recipe routes network requests made by the pi child process through an embedded [`proxy-chain`](https://github.com/apify/proxy-chain) server with an exact-host allowlist.
It requires a custom container image, but it does not require changes to pi-chat-runner itself.

This is a best-effort application control, not a sandbox, firewall, or security boundary.
An agent that can execute arbitrary code can ignore the proxy environment variables and open a direct socket from the Cloud Run container.
Use this setup to prevent accidental access and audit cooperative clients.

## How it fits into pi-chat-runner

```text
Cloud Run container
  Node.js process
    --import preload.mjs
      proxy-chain on 127.0.0.1:8888
    /app/dist/server.mjs
      pi-chat-runner
        pi child process
          HTTPS_PROXY=http://127.0.0.1:8888
          NODE_USE_ENV_PROXY=1
          NO_PROXY=Cloud Run metadata server
```

`proxy-chain` implements the forward proxy protocol, HTTP `CONNECT` handling, DNS resolution, TCP tunneling, and socket lifecycle.
The custom preload module only supplies an allowlist callback and waits for the proxy to listen.
Node.js then starts the unmodified pi-chat-runner entrypoint.

The proxy does not decrypt TLS.
It can restrict a destination hostname and port, but it cannot inspect an HTTPS path, HTTP method, Slack workspace, or Slack API method.

## Create the custom image

Create these files for the derived image.

```text
custom-image/
  Dockerfile
  agent.yaml
  egress-proxy/
    package.json
    package-lock.json
    preload.mjs
```

### Install `proxy-chain`

Create `egress-proxy/package.json`.

```json
{
  "name": "pi-chat-runner-egress-proxy",
  "private": true,
  "type": "module",
  "dependencies": {
    "proxy-chain": "3.0.0"
  }
}
```

Generate and commit the lockfile.

```sh
cd custom-image/egress-proxy
npm install --package-lock-only --ignore-scripts
```

### Preload the proxy

Create `egress-proxy/preload.mjs`.

```js
import { RequestError, Server } from "proxy-chain";

const allowedHosts = new Set(
  (process.env.PI_EGRESS_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase().replace(/\.+$/, ""))
    .filter(Boolean),
);

if (allowedHosts.size === 0) {
  throw new Error("PI_EGRESS_ALLOWED_HOSTS must not be empty");
}

const proxy = new Server({
  host: "127.0.0.1",
  port: Number(process.env.PI_EGRESS_PROXY_PORT ?? "8888"),
  prepareRequestFunction: ({ hostname, port, isHttp, connectionId }) => {
    const host = hostname.toLowerCase().replace(/\.+$/, "");
    const allowed = !isHttp && port === 443 && allowedHosts.has(host);

    console.log(
      JSON.stringify({
        component: "egress-proxy",
        connectionId,
        destination: `${host}:${port}`,
        decision: allowed ? "allow" : "deny",
      }),
    );

    if (!allowed) {
      throw new RequestError("Destination is not allowed", 403);
    }

    return {};
  },
});

await proxy.listen();
console.log(
  JSON.stringify({
    component: "egress-proxy",
    message: "listening",
    allowedHosts: [...allowedHosts],
  }),
);
```

The callback allows only HTTPS `CONNECT` requests to port 443 and exact hostnames from `PI_EGRESS_ALLOWED_HOSTS`.
Plain HTTP proxy requests and all other destinations are rejected.
Node.js [`--import`](https://nodejs.org/api/cli.html#--importmodule) preloads this ES module before evaluating the application entrypoint.
The top-level `await proxy.listen()` therefore completes before pi-chat-runner starts.

### Build on top of pi-chat-runner

Create `custom-image/Dockerfile`.

```dockerfile
FROM node:26-slim AS proxy-dependencies

WORKDIR /opt/egress-proxy
COPY egress-proxy/package.json egress-proxy/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM <PI_CHAT_RUNNER_BASE_IMAGE>

COPY --from=proxy-dependencies /opt/egress-proxy/node_modules \
  /opt/egress-proxy/node_modules
COPY egress-proxy/preload.mjs /opt/egress-proxy/preload.mjs
COPY agent.yaml /app/config/agent.yaml

ENV CONFIG_PATH=/app/config/agent.yaml
CMD ["node", "--import", "/opt/egress-proxy/preload.mjs", "/app/dist/server.mjs"]
```

Replace `<PI_CHAT_RUNNER_BASE_IMAGE>` with the pi-chat-runner image used by the deployment.
Keeping `proxy-chain` under `/opt/egress-proxy` avoids modifying the base image's `/app/package.json` and `/app/node_modules`.
If the deployment already supplies `agent.yaml` through another image layer, keep that mechanism instead of the `COPY` and `CONFIG_PATH` lines above.

Use the explicit `--import` argument in `CMD` rather than setting `NODE_OPTIONS`.
This keeps the preload attached to the container entrypoint instead of making it an ambient option for other Node.js commands.

## Pass proxy settings only to pi

Merge the following values into the `agent.env` block of `agent.yaml`.

```yaml
agent:
  env:
    HTTP_PROXY: http://127.0.0.1:8888
    HTTPS_PROXY: http://127.0.0.1:8888
    http_proxy: http://127.0.0.1:8888
    https_proxy: http://127.0.0.1:8888
    NO_PROXY: 127.0.0.1,localhost,metadata.google.internal,metadata.google.internal.,169.254.169.254
    no_proxy: 127.0.0.1,localhost,metadata.google.internal,metadata.google.internal.,169.254.169.254
    NODE_USE_ENV_PROXY: "1"
```

pi-chat-runner passes `agent.env` to the pi child process without passing the runner's Slack token or other secrets.
Commands launched by pi inherit the same proxy variables.

Do not set these proxy variables as container-wide Cloud Run variables unless the runner's own Slack, Firestore, and GCS traffic should also use the proxy.
Keeping them in `agent.env` limits the behavior change to pi.

Node.js 26 `fetch` honors the proxy variables when `NODE_USE_ENV_PROXY=1` is present at process startup.
Other clients must be checked separately.
A gRPC client may require `grpc_proxy`, and any program can choose to ignore proxy variables.

## Configure allowed destinations

Set `PI_EGRESS_ALLOWED_HOSTS` on the custom container.
This variable configures the preload module and is not passed to pi unless it is also listed in `agent.env`.

```yaml
env:
  - name: PI_EGRESS_ALLOWED_HOSTS
    value: asia-northeast1-aiplatform.googleapis.com,logging.googleapis.com
  - name: PI_EGRESS_PROXY_PORT
    value: "8888"
```

Choose the Vertex AI hostname from `GOOGLE_CLOUD_LOCATION`.

| Use | Host to allow |
|---|---|
| Vertex AI with location `global` | `aiplatform.googleapis.com` |
| Vertex AI with a regional location | `<location>-aiplatform.googleapis.com` |
| Cloud Logging REST API | `logging.googleapis.com` |
| Slack Web API called by pi | `slack.com` |
| Slack file download called by pi | `files.slack.com` |

The runner's own Slack connection does not need `slack.com` in this list because the runner does not receive the values from `agent.env`.
Allow Slack only when a tool or command executed by pi calls Slack directly.

Avoid broad entries such as every `googleapis.com` subdomain.
List each API hostname that the agent needs.

## Preserve ADC

Keep the normal Cloud Run service account attachment and Google Cloud variables.

```yaml
env:
  - name: GOOGLE_CLOUD_PROJECT
    value: <PROJECT_ID>
  - name: GOOGLE_CLOUD_LOCATION
    value: asia-northeast1
  - name: METADATA_SERVER_DETECTION
    value: assume-present
```

The metadata host is listed in `NO_PROXY`, so Google authentication obtains a short-lived access token directly from the Cloud Run metadata server.
The token is then used for Vertex AI and other allowed Google Cloud APIs through the proxy.

Do not mount a service account key solely for this setup.
Attach a least-privilege service account with only the permissions the agent needs.

## Verify the behavior

Verify the real pi-coding-agent path after deploying the derived image.

1. Start a pi turn that uses a `google-vertex` Gemini model and confirm that the turn completes.
2. Confirm that the proxy logs an `allow` decision for the configured Vertex AI hostname.
3. Have pi run `curl -I https://example.com` and confirm that the proxy logs a `deny` decision.
4. If Cloud Logging is available to pi, write and read a test log entry and confirm an `allow` decision for `logging.googleapis.com`.
5. Confirm that ADC reports the expected project and service account without a credential file.

The following negative control demonstrates the limitation of this design.

```sh
curl --noproxy '*' -I https://example.com
```

The negative control can succeed because it bypasses the proxy variables.
That result is expected and proves that this configuration is not a sandbox.

## Security limits

This recipe does not guarantee that the agent can reach only the allowed hosts.
The pi child process shares the Cloud Run network namespace and can make direct outbound connections.
Node.js Permission Model cannot express a hostname allowlist and is configured with network access enabled for pi.

An allowed HTTPS hostname is a possible data-exfiltration destination.
For example, allowing `slack.com` does not restrict the workspace, channel, token, or API method because the proxy sees only the hostname and port.
Use an application-level Slack broker when those restrictions matter.

For enforced egress control, route all Cloud Run traffic through Direct VPC egress and remove direct public egress from the workload subnet.
Place the proxy at that network boundary so that clearing `HTTPS_PROXY` does not restore direct connectivity.
