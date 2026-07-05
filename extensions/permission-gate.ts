/**
 * permission-gate extension
 *
 * bash tool の tool_call をインターセプトし、denylist パターンにマッチした
 * コマンドを block する事故防止層 (docs/research/pi-tools-and-sandbox.md
 * 「bash tool の挙動とコマンド allowlist」「sandbox / セキュリティの手」)。
 *
 * **denylist から開始する方針**: シェル文字列の判定 (`;` / `&&` / `|` /
 * `$(...)` / バッククォート / `xargs` / `sh -c` 等の合成・置換) には
 * 本質的な穴があり、素朴な正規表現では敵対的入力への境界を作れない。
 * ここで防ぎたいのは悪意ある入力ではなく、エージェントが誤って (あるいは
 * 指示された通りに素直に) 実行してしまう「事故」— パッケージの grep インストール、
 * ルート直下の削除、Runner プロセスへの kill 等。厳密な allowlist は将来、
 * チャンネル用途別プロファイル (--tools 制限 + registerTool による専用ツール化)
 * で行う (pi-tools-and-sandbox.md 「deny-all + ホワイトリスト許可の実現手段」)。
 *
 * 回避可能なのは織り込み済み: `sh -c 'apt install x'` を `base64 -d | sh` 等で
 * 包めばこの判定は素通りする。これは意図的なトレードオフであり、
 * 「LLM が素直に打つコマンド」を弾くための層である。
 *
 * pi が `--extension` でソースのまま直接ロードするため、ビルド対象外
 * (reply.ts と同じ規約)。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** denylist 判定結果。block なら reason をエージェントへの説明として返す */
export interface DenylistMatch {
	pattern: string;
	reason: string;
}

interface DenylistRule {
	/** 判定用パターン (case-insensitive) */
	pattern: RegExp;
	/** block 時にエージェントへ返す reason。方針転換できるよう代替手段を示す */
	reason: string;
}

// パッケージ・システム変更: イメージは固定の調査ツールセットで完結させる方針
// (session-runtime.md §5)。実行時のインストールは「そのセッションだけ入って
// 次のセッションには無い」再現性の無い状態を生むため、事故として弾く
const PACKAGE_MANAGEMENT_RULES: DenylistRule[] = [
	{
		pattern: /\b(apt|apt-get|dpkg)\b/i,
		reason:
			"package installation via apt/apt-get/dpkg is not allowed in this environment; use preinstalled tools, or ask to extend the base image instead",
	},
	{
		pattern:
			/\bnpm\s+(i|install)\s+(-g|--global)\b|\bnpm\s+(-g|--global)\s+(i|install)\b/i,
		reason:
			"global npm install is not allowed in this environment; use preinstalled tools, or ask to extend the base image instead",
	},
	{
		// pip install はグローバル汚染が事故の本質なので --user は許す
		pattern: /\bpip[3]?\s+install\b(?!.*--user)/i,
		reason:
			"pip install without --user is not allowed in this environment; use preinstalled tools, `pip install --user`, or ask to extend the base image instead",
	},
	{
		pattern: /\bgem\s+install\b/i,
		reason:
			"gem install is not allowed in this environment; use preinstalled tools, or ask to extend the base image instead",
	},
	{
		pattern: /\bbrew\b/i,
		reason:
			"Homebrew is not allowed in this environment; use preinstalled tools, or ask to extend the base image instead",
	},
];

// 破壊系: プロセス全体・ディスク全体に影響する誤操作を弾く
const DESTRUCTIVE_RULES: DenylistRule[] = [
	{
		// rm -rf / (末尾がルートそのもの、または直下パス)。rm -rf /workdir/foo のような
		// workdir 配下の削除は許す (雑判定: `/` の直後に空白か行末が続くケースだけ狙う)
		pattern: /\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+\/(\s|$)/i,
		reason:
			"rm -rf targeting root (/) is blocked; scope the command to a specific path under the working directory",
	},
	{
		pattern: /\bmkfs\b/i,
		reason:
			"mkfs (filesystem formatting) is blocked as a destructive operation",
	},
	{
		pattern: /\bdd\b.*\bof=\/dev\//i,
		reason:
			"dd writing directly to a /dev/ block device is blocked as a destructive operation",
	},
];

// 権限・所有: workdir 外の絶対パスに対する chmod/chown は雑判定でよいので、
// 主要な非 workdir ディレクトリを列挙して弾く (session-runtime.md §6 の
// UID 分離・0700 権限を bash から崩されないようにする事故防止)
const PERMISSION_RULES: DenylistRule[] = [
	{
		pattern: /\b(chmod|chown)\b.*(\/app|\/data|\/etc|\/usr|\/root)(\/|\s|$)/i,
		reason:
			"chmod/chown targeting /app, /data, /etc, /usr, or /root is blocked; scope permission changes to the working directory",
	},
];

// Runner への干渉: pid 1 (コンテナ内の init = Runner 自身) への kill は
// セッション全体を落としてしまうため弾く
const RUNNER_INTERFERENCE_RULES: DenylistRule[] = [
	{
		pattern: /\bkill\s+(-9|-kill|-sigkill)\s+1\b/i,
		reason:
			"killing pid 1 (the container's init / Runner process) is blocked; this would terminate the whole session unexpectedly",
	},
];

export const DENYLIST_RULES: DenylistRule[] = [
	...PACKAGE_MANAGEMENT_RULES,
	...DESTRUCTIVE_RULES,
	...PERMISSION_RULES,
	...RUNNER_INTERFERENCE_RULES,
];

/**
 * bash コマンド文字列を denylist に照らして判定する純粋関数 (テスト対象)。
 * 素朴な正規表現マッチであり、シェルの合成・置換 (`;`, `&&`, `$(...)` 等) を
 * 経由した回避は防げない (このファイル冒頭のコメント参照)。
 */
export function matchDenylist(command: string): DenylistMatch | undefined {
	for (const rule of DENYLIST_RULES) {
		if (rule.pattern.test(command)) {
			return { pattern: rule.pattern.source, reason: rule.reason };
		}
	}
	return undefined;
}

export default function permissionGateExtension(pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return undefined;
		const command = event.input.command as string;
		const match = matchDenylist(command);
		if (match === undefined) return undefined;
		return { block: true, reason: match.reason };
	});
}
