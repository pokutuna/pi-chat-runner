// Points gcloud at the mounted GOOGLE_APPLICATION_CREDENTIALS and sets the
// default project on every pi process start, so the agent never has to run
// `gcloud auth` / `gcloud config` itself to check them.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let statusLine: string | undefined;

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
