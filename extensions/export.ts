/**
 * export extension
 *
 * pi の extension API で `export_session` ツールを登録する。
 * execute は現在のセッション (workdir/session.jsonl) を HTML にエクスポートし、
 * 生成した絶対パスを同期的に返す。agent はそのパスを自由に使ってよい (reply の
 * files に添付する、workdir に残すだけにする、等)。reply の files は workdir 相対
 * パスを期待するが、resolveReplyFiles は path.resolve で解決するため workdir 内の
 * 絶対パスも同じ結果になり、そのまま渡して問題ない (runtime.md §5.4)。
 *
 * pi の extension サンドボックス (ExtensionContext) はセッションの読み取り専用
 * ビュー (sessionManager) しか持たず、`exportToHtml` を直接呼べない
 * (AgentSession インスタンスは extension に露出しない)。そのため `pi --export`
 * を別プロセスとして起動する。呼び出しには pi 本体のエントリポイントが要るため、
 * ホスト (server.ts) が PI_EXPORT_ENTRYPOINT 環境変数で絶対パスを渡す。
 *
 * この孫プロセスは pi 本体の子なので、pi の bash tool と同じ uid・同じ srt sandbox
 * の中で動き、agent が bash で得られる以上の権限は持たない。それでも読み書きする
 * パスは ctx.cwd (workdir) 由来に固定し、parameters は空のまま保つ。
 *
 * pi が `--extension` でソースのまま直接ロードするため、ビルド対象外。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// src/runtime/session-file.ts の SESSION_FILE と同値。extension はビルド成果物を
// import できない (ソース直接ロードのため) ので、reply.ts と同様にここで自己完結させる。
const SESSION_FILE = "session.jsonl";

export default function exportExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "export_session",
    label: "Export session",
    description:
      "Export the current conversation to a self-contained HTML file in the workdir and return its path. Use this when a task or skill wants to hand off a readable record of the session (e.g. to attach via reply).",
    promptSnippet:
      "export_session(): Export the current session to HTML in the workdir; returns its absolute path.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const entrypoint = process.env.PI_EXPORT_ENTRYPOINT;
      if (entrypoint === undefined) {
        throw new Error(
          "export_session: PI_EXPORT_ENTRYPOINT is not set (host must inject it)",
        );
      }
      const sessionPath = `${ctx.cwd}/${SESSION_FILE}`;
      const outPath = `${ctx.cwd}/session-export-${Date.now()}.html`;
      const result = await pi.exec(process.execPath, [
        entrypoint,
        "--export",
        sessionPath,
        outPath,
      ]);
      if (result.code !== 0) {
        throw new Error(`export_session: pi --export failed: ${result.stderr}`);
      }
      return {
        content: [{ type: "text", text: outPath }],
        details: { path: outPath },
      };
    },
  });
}
