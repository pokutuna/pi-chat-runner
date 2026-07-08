// AgentConfig スキーマ + ローダー — docs/design/config.md §6「agent.yaml — bridge 本体の設定ファイル」
//
// channels/*.yaml (channel-doc.ts) とは別のファイルとして合流させない (config.md §6 の表:
// 「対象」「読むタイミング」「Firestore」が異なるため)。zod strict + fail-loud は
// channel-doc.ts / config-source.ts と同じ流儀。
//
// 優先順位は env > agent.yaml > コード既定 (config.md §6)。コード既定 (turnTimeoutMs
// 600_000 等) はこのモジュールでは埋めない — 既定値の二重管理をしない
// (旧 server.ts parseTurnTimeoutMs と同じ理由)。SessionRunner 側の既定に委ねる。
//
// agent.env は足し算モデル: pi に渡る env は「コード既定 (gcpEnv 等) + agent.env に
// 明示列挙したものだけ」。旧 envPassthrough (process.env から allowlist で選ぶ引き算
// モデル) は廃止した。値には ${env.X} / ${env.X:-default} 参照を書ける
// (resolveEnvRefs で yaml.parse 後・zod 前に解決する)。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { resolveEnvRefs } from "./env-ref.js";

const AgentConfigPiSchema = z
	.object({
		provider: z.string().optional(),
		/** ${env.X} 解決後は文字列で来る可能性があるため coerce する (uid/gid 等と同じ理由)。 */
		turnTimeoutMs: z.coerce.number().int().positive().optional(),
	})
	.strict();

/** ${env.X} 解決後の permissionMode を boolean に解釈する。env-ref は string しか
 * 返さないため、YAML に native boolean で書いた場合 (boolean のまま来る) と ${env.X}
 * 参照で書いた場合 ("true"/"false"/"0"/"1"/"" の文字列で来る) の両方を受ける。
 * z.coerce.boolean() は "false" や "0" も truthy にしてしまい sandbox を OFF に
 * できない罠があるため使わない — 文字列は "0"/"false"/"" (大小無視) を false、
 * それ以外を true と解釈する (env 直読み経路 parsePermissionModeEnv と同じ規則)。 */
const PermissionModeSchema = z.preprocess((value) => {
	if (typeof value === "string") {
		const v = value.trim().toLowerCase();
		return v !== "" && v !== "0" && v !== "false";
	}
	return value;
}, z.boolean().optional());

/** pi 子プロセスの実行環境設定 (session-runtime.md §6)。${env.X} 解決後に zod で
 * 型を確定する — uid/gid は文字列でも number に coerce する。permissionMode は
 * coerce の罠を避けるため専用の PermissionModeSchema で解釈する。 */
const AgentRuntimeSchema = z
	.object({
		uid: z.coerce.number().int().optional(),
		gid: z.coerce.number().int().optional(),
		permissionMode: PermissionModeSchema,
		home: z.string().optional(),
	})
	.strict();

const AgentAgentSchema = z
	.object({
		/** pi 子プロセスへ渡す env の名前=値マップ (足し算モデル)。値は ${env.X} 参照可。 */
		env: z.record(z.string(), z.string()).optional(),
		runtime: AgentRuntimeSchema.optional(),
	})
	.strict();

export const AgentConfigSchema = z
	.object({
		pi: AgentConfigPiSchema.optional(),
		agent: AgentAgentSchema.optional(),
	})
	.strict();

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

const AGENT_CONFIG_FILENAME = "agent.yaml";

/** CONFIG_DIR/agent.yaml を読む。ファイル自体が無ければ全項目省略として `{}` を返す
 * (config.md §6: 「ファイル自体が無ければ全項目コード既定」)。コメントだけの YAML
 * (parse 結果が null) も同様に `{}` 扱い。YAML parse 後・zod 検証前に resolveEnvRefs
 * で ${env.X} 参照を解決する (env-ref.ts の「A2: parse 後走査」方式)。スキーマ違反・
 * YAML 破損・未解決の env 参照は fail-loud で throw する (config-source.ts の
 * loadChannelDocFile と同じ形式)。 */
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
	if (typeof parsed !== "object") {
		throw new Error(`invalid agent config file: ${filePath} (not an object)`);
	}

	// agent.yaml には connector / store ブロックも同居する (connector-config.ts /
	// store-config.ts が並行してそれぞれ読む)。AgentConfigSchema は pi/agent しか
	// 知らない .strict() スキーマなので、ここで pi/agent キーだけを取り出してから
	// 検証する (parsed をそのまま渡すと connector/store が unrecognized keys で弾かれる)。
	const { pi: piRaw, agent: agentRaw } = parsed as Record<string, unknown>;
	const extracted: Record<string, unknown> = {};
	if (piRaw !== undefined) extracted.pi = piRaw;
	if (agentRaw !== undefined) extracted.agent = agentRaw;

	let resolved: unknown;
	try {
		resolved = resolveEnvRefs(extracted, process.env);
	} catch (err) {
		throw new Error(
			`failed to resolve \${env.*} references in agent config file: ${filePath}`,
			{ cause: err },
		);
	}

	const result = AgentConfigSchema.safeParse(resolved);
	if (!result.success) {
		const issues = result.error.issues
			.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
			.join("\n");
		throw new Error(`invalid agent config schema in ${filePath}:\n${issues}`);
	}
	return result.data;
}

/** loadAgentConfig / resolveAgentConfig を通した後の平坦な設定。省略されたフィールドは
 * undefined のまま (SessionRunner の既定に委ねる)。env / runtime は「値を渡さない」が
 * この項目の既定挙動そのものであり、上位で undefined 分岐を増やす必要が無いため
 * 常に埋めて返す (env は既定 {}、runtime.permissionMode は既定 true、
 * runtime.home は既定 "/home/agent")。 */
export interface ResolvedAgentConfig {
	provider?: string;
	turnTimeoutMs?: number;
	/** pi 子プロセスへ明示的に渡す env (agent.env の解決結果)。コード既定 (gcpEnv 等)
	 * と合流させるかどうかは呼び出し側の責務。 */
	env: Record<string, string>;
	runtime: ResolvedAgentRuntime;
}

export interface ResolvedAgentRuntime {
	uid?: number;
	gid?: number;
	/** Node Permission Model 起動の有効/無効。コード既定は ON (true) — 書かなければ
	 * 隔離が効く。env PI_PERMISSION_MODE=0 または agent.yaml の
	 * agent.runtime.permissionMode: false で切れる。 */
	permissionMode: boolean;
	/** pi 子プロセスへ常に HOME として渡すディレクトリ。既定 "/home/agent"。 */
	home: string;
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

/** env PI_AGENT_UID / PI_AGENT_GID (session-runtime.md §6: UID 分離) を数値として
 * パースする。どちらも省略時は undefined (file の値を使う分岐に委ねる)。片方だけ
 * 設定されているのは誤設定なので fail-loud にする。 */
function parseAgentIdsEnv(env: NodeJS.ProcessEnv): {
	uid?: number;
	gid?: number;
} {
	const uidRaw = env.PI_AGENT_UID;
	const gidRaw = env.PI_AGENT_GID;
	if (uidRaw === undefined && gidRaw === undefined) return {};
	if (uidRaw === undefined || gidRaw === undefined) {
		throw new Error(
			"PI_AGENT_UID and PI_AGENT_GID must be set together (or both omitted)",
		);
	}
	const uid = Number.parseInt(uidRaw, 10);
	const gid = Number.parseInt(gidRaw, 10);
	if (Number.isNaN(uid) || Number.isNaN(gid)) {
		throw new Error("PI_AGENT_UID and PI_AGENT_GID must be integers");
	}
	return { uid, gid };
}

/** env PI_PERMISSION_MODE をパースする。未設定なら undefined (file/コード既定に
 * 委ねる)。"0" は明示的に無効化、それ以外の値は有効化として扱う。 */
function parsePermissionModeEnv(raw: string | undefined): boolean | undefined {
	if (raw === undefined || raw === "") return undefined;
	return raw !== "0";
}

/** agent.yaml の内容と env を合わせて解決する。優先順位は env > agent.yaml
 * (config.md §6)。コード既定はここでは埋めない (turnTimeoutMs 等は undefined のまま
 * 返し、SessionRunner の既定に委ねる) が、env / runtime はこのモジュールが
 * コード既定 (env: {} / permissionMode: true / home: "/home/agent") を埋めて返す
 * (「値を渡さない」「隔離する」がそれぞれの既定挙動そのものであるため)。 */
export function resolveAgentConfig(
	file: AgentConfig,
	env: NodeJS.ProcessEnv,
): ResolvedAgentConfig {
	const provider = env.PI_PROVIDER ?? file.pi?.provider;
	const turnTimeoutMs =
		parseTurnTimeoutMsEnv(env.TURN_TIMEOUT_MS) ?? file.pi?.turnTimeoutMs;

	const agentEnv = file.agent?.env ?? {};

	const agentIdsFromEnv = parseAgentIdsEnv(env);
	const uid = agentIdsFromEnv.uid ?? file.agent?.runtime?.uid;
	const gid = agentIdsFromEnv.gid ?? file.agent?.runtime?.gid;
	const permissionMode =
		parsePermissionModeEnv(env.PI_PERMISSION_MODE) ??
		file.agent?.runtime?.permissionMode ??
		true;
	const home = env.PI_AGENT_HOME ?? file.agent?.runtime?.home ?? "/home/agent";

	return {
		...(provider !== undefined ? { provider } : {}),
		...(turnTimeoutMs !== undefined ? { turnTimeoutMs } : {}),
		env: agentEnv,
		runtime: {
			...(uid !== undefined ? { uid } : {}),
			...(gid !== undefined ? { gid } : {}),
			permissionMode,
			home,
		},
	};
}
