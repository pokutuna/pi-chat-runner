// Configures gcloud credentials and the default project on every pi process
// start, so the agent never has to run `gcloud auth` / `gcloud config` itself
// to check them.
//
// Credentials come from the mounted GOOGLE_APPLICATION_CREDENTIALS when set
// (local compose). Otherwise (Cloud Run) they come from the metadata server:
// gcloud's own GCE detection connects to the metadata server directly,
// ignoring HTTP_PROXY, which the srt sandbox blocks. So the token is fetched
// here through the sandbox proxy and handed to gcloud as auth/access_token_file.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { get, type RequestOptions } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const TOKEN_FILE = join(
  homedir(),
  ".config",
  "gcloud",
  "metadata-access-token",
);
// Refresh this long before the token expires.
const REFRESH_MARGIN_SEC = 300;

let statusLine: string | undefined;
let refreshTimer: NodeJS.Timeout | undefined;

// Sends a GET to the metadata server through HTTP_PROXY (the srt sandbox
// proxy; metadata.google.internal is in its allowlist), or directly when no
// proxy is set.
function getMetadata(url: string): Promise<string> {
  const proxy = process.env.HTTP_PROXY || process.env.http_proxy;
  const headers: Record<string, string> = { "Metadata-Flavor": "Google" };
  let options: RequestOptions;
  if (proxy) {
    const p = new URL(proxy);
    if (p.username) {
      const credentials = `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`;
      headers["Proxy-Authorization"] =
        `Basic ${Buffer.from(credentials).toString("base64")}`;
    }
    // A plain-HTTP request through a proxy carries the absolute URL as its path.
    options = { host: p.hostname, port: p.port, path: url, headers };
  } else {
    const u = new URL(url);
    options = { host: u.hostname, port: u.port, path: u.pathname, headers };
  }
  return new Promise((resolve, reject) => {
    const req = get({ ...options, timeout: 10_000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () =>
        res.statusCode === 200
          ? resolve(body)
          : reject(new Error(`metadata server: HTTP ${res.statusCode}`)),
      );
    });
    req.on("timeout", () => req.destroy(new Error("metadata server: timeout")));
    req.on("error", reject);
  });
}

// Fetches a token and writes it atomically so a gcloud running in another
// session never reads a partial file. Returns the token lifetime in seconds.
async function refreshToken(): Promise<number> {
  const { access_token, expires_in } = JSON.parse(
    await getMetadata(TOKEN_URL),
  ) as { access_token: string; expires_in: number };
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  const tmp = `${TOKEN_FILE}.${process.pid}`;
  writeFileSync(tmp, access_token, { mode: 0o600 });
  renameSync(tmp, TOKEN_FILE);
  return expires_in;
}

function scheduleRefresh(expiresInSec: number) {
  clearTimeout(refreshTimer);
  const delaySec = Math.max(expiresInSec - REFRESH_MARGIN_SEC, 60);
  refreshTimer = setTimeout(async () => {
    const next = await refreshToken().catch(() => undefined);
    scheduleRefresh(next ?? 60 + REFRESH_MARGIN_SEC);
  }, delaySec * 1000);
  refreshTimer.unref();
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    const lines: string[] = [];

    const credentialFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (credentialFile) {
      await pi.exec("gcloud", [
        "config",
        "set",
        "auth/credential_file_override",
        credentialFile,
      ]);
      lines.push(`credentials: ${credentialFile}`);
    } else {
      const expiresIn = await refreshToken().catch(() => undefined);
      if (expiresIn !== undefined) {
        await pi.exec("gcloud", [
          "config",
          "set",
          "auth/access_token_file",
          TOKEN_FILE,
        ]);
        scheduleRefresh(expiresIn);
        lines.push("credentials: service account of this Cloud Run service");
      }
    }

    const project = process.env.GOOGLE_CLOUD_PROJECT;
    if (project) {
      await pi.exec("gcloud", ["config", "set", "project", project]);
      lines.push(`project: ${project}`);
    }

    statusLine = lines.length > 0 ? lines.join(", ") : undefined;
  });

  pi.on("before_agent_start", async (event) => {
    if (!statusLine) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\ngcloud is already configured (${statusLine}) — don't run \`gcloud auth\` / \`gcloud config\` to check it.`,
    };
  });
}
