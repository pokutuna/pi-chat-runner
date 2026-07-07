// AgentConfig スキーマ + ローダー — docs/design/config.md §6「agent.yaml — bridge 本体の設定ファイル」,
// docs/design/session-runtime.md §2「ユーザー CLI のための allowlist 拡張 (envPassthrough)」
//
// channels/*.yaml (channel-doc.ts) とは別のファイルとして合流させない (config.md §6 の表:
// 「対象」「読むタイミング」「Firestore」が異なるため)。zod strict + fail-loud は
// channel-doc.ts / config-source.ts と同じ流儀。
//
// 優先順位は env > agent.yaml > コード既定 (config.md §6)。コード既定 (turnTimeoutMs
// 600_000 等) はこのモジュールでは埋めない — 既定値の二重管理をしない
// (旧 server.ts parseTurnTimeoutMs と同じ理由)。SessionRunner 側の既定に委ねる。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** bridge 予約 prefix。SLACK_ / BRIDGE_ で始まる名前は envPassthrough (agent.yaml / env
 * どちらの経路でも) に列挙できない。誤設定で bot token 等が pi へ漏れる事故を防ぐ
 * (session-runtime.md §2 の安全弁)。 */
const RESERVED_ENV_PREFIXES = ["SLACK_", "BRIDGE_"];

const AgentConfigPiSchema = z
	.object({
		provider: z.string().optional(),
		model: z.string().optional(),
		turnTimeoutMs: z.number().int().positive().optional(),
		envPassthrough: z.array(z.string()).optional(),
	})
	.strict();

export const AgentConfigSchema = z
	.object({
		pi: AgentConfigPiSchema.optional(),
	})
	.strict();

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

const AGENT_CONFIG_FILENAME = "agent.yaml";

/** CONFIG_DIR/agent.yaml を読む。ファイル自体が無ければ全項目省略として `{}` を返す
 * (config.md §6: 「ファイル自体が無ければ全項目コード既定」)。コメントだけの YAML
 * (parse 結果が null) も同様に `{}` 扱い。スキーマ違反・YAML 破損はファイルパス + zod
 * issue 付きで throw する (fail-loud。config-source.ts の loadChannelDocFile と同じ形式)。 */
export async function loadAgentConfig(configDir: string): Promise<AgentConfig> {
	const filePath = join(configDir, AGENT_CONFIG_FILENAME);

	let raw: string;
	try {
		raw = await readFile(filePath, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return {};
		}
		throw new Error(`failed to read agent config file: ${filePath}`, {
			cause: err,
		});
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (err) {
		throw new Error(`invalid YAML in agent config file: ${filePath}`, {
			cause: err,
		});
	}

	if (parsed === null || parsed === undefined) {
		return {};
	}

	const result = AgentConfigSchema.safeParse(parsed);
	if (!result.success) {
		const issues = result.error.issues
			.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
			.join("\n");
		throw new Error(`invalid agent config schema in ${filePath}:\n${issues}`);
	}
	return result.data;
}

/** loadAgentConfig / resolveAgentConfig を通した後の平坦な設定。省略されたフィールドは
 * undefined のまま (SessionRunner の既定に委ねる。envPassthrough だけは既定 [] を持つ
 * — 「値を継承しない」がこの項目の既定挙動そのものであり、上位で undefined 分岐を
 * 増やす必要が無いため)。 */
export interface ResolvedAgentConfig {
	provider?: string;
	model?: string;
	turnTimeoutMs?: number;
	envPassthrough: string[];
}

/** env TURN_TIMEOUT_MS をパースする (旧 server.ts の parseTurnTimeoutMs をここへ移動)。
 * 未設定/空文字は undefined。0 や負数・非整数は setTimeout の即時発火や無意味な
 * タイムアウトに繋がるため fail-loud で弾く。 */
function parseTurnTimeoutMsEnv(raw: string | undefined): number | undefined {
	if (raw === undefined || raw === "") return undefined;
	const value = Number.parseInt(raw, 10);
	if (Number.isNaN(value) || value <= 0 || !Number.isInteger(value)) {
		throw new Error(
			"TURN_TIMEOUT_MS must be a positive integer (milliseconds)",
		);
	}
	return value;
}

/** env PI_ENV_PASSTHROUGH (カンマ区切り) をパースする。trim + 空要素除去。未設定は
 * undefined (file の値を使う分岐に委ねる)。 */
function parseEnvPassthroughEnv(raw: string | undefined): string[] | undefined {
	if (raw === undefined) return undefined;
	return raw
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
}

/** RESERVED_ENV_PREFIXES に該当する名前が混じっていないか検証する。混じっていれば
 * どちらの経路 (env/file) の由来かを含めて throw する (session-runtime.md §2 の安全弁)。 */
function assertNoReservedNames(
	names: string[],
	source: "agent.yaml" | "env",
): void {
	const reserved = names.filter((name) =>
		RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)),
	);
	if (reserved.length > 0) {
		throw new Error(
			`envPassthrough (${source}) must not include reserved bridge env names: ${reserved.join(", ")} ` +
				`(reserved prefixes: ${RESERVED_ENV_PREFIXES.join(", ")})`,
		);
	}
}

/** agent.yaml の内容と env を合わせて解決する。優先順位は env > agent.yaml
 * (config.md §6)。コード既定はここでは埋めない (turnTimeoutMs 等は undefined のまま
 * 返し、SessionRunner の既定に委ねる)。envPassthrough は file のリストを丸ごと置換
 * する override であり、file と env の値を混ぜて足し合わせることはしない。 */
export function resolveAgentConfig(
	file: AgentConfig,
	env: NodeJS.ProcessEnv,
): ResolvedAgentConfig {
	const provider = env.PI_PROVIDER ?? file.pi?.provider;
	const model = env.PI_MODEL ?? file.pi?.model;
	const turnTimeoutMs =
		parseTurnTimeoutMsEnv(env.TURN_TIMEOUT_MS) ?? file.pi?.turnTimeoutMs;

	const envPassthroughFromEnv = parseEnvPassthroughEnv(env.PI_ENV_PASSTHROUGH);
	if (envPassthroughFromEnv !== undefined) {
		assertNoReservedNames(envPassthroughFromEnv, "env");
	}
	const fileEnvPassthrough = file.pi?.envPassthrough;
	if (fileEnvPassthrough !== undefined) {
		assertNoReservedNames(fileEnvPassthrough, "agent.yaml");
	}
	const envPassthrough = envPassthroughFromEnv ?? fileEnvPassthrough ?? [];

	return {
		...(provider !== undefined ? { provider } : {}),
		...(model !== undefined ? { model } : {}),
		...(turnTimeoutMs !== undefined ? { turnTimeoutMs } : {}),
		envPassthrough,
	};
}

export interface CollectedPassthroughEnv {
	/** names のうち process.env に実在した名前だけの値マップ。 */
	env: Record<string, string>;
	/** names のうち process.env に存在しなかった名前 (呼び出し側で warn ログ用)。値は
	 * 元々無いので漏れる心配は無い。 */
	missing: string[];
}

/** envPassthrough の名前リストを実際の値に解決する。存在しない名前は env に含めず
 * missing に集める (呼び出し側で名前だけ warn ログできるように。値は返さない)。 */
export function collectPassthroughEnv(
	names: string[],
	env: NodeJS.ProcessEnv,
): CollectedPassthroughEnv {
	const result: Record<string, string> = {};
	const missing: string[] = [];
	for (const name of names) {
		const value = env[name];
		if (value === undefined) {
			missing.push(name);
		} else {
			result[name] = value;
		}
	}
	return { env: result, missing };
}
