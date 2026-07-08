// StoreConfig スキーマ + ローダー — 永続化ストア (State Store) の設定ブロック。
//
// agent.yaml に同居する (config.md §6 の agent.yaml と同じファイルを読む。ファイルを
// 増やさない)。agent.yaml 全体は 1 つの zod スキーマに統合せず、この store ブロック
// だけを取り出して独立に読む (agent スキーマ本体は別モジュールが並行して定義するため)。
//
// 値は `${env.X}` / `${env.X:-default}` 参照を書ける (env-ref.ts)。読み込み順は
// yaml.parse → resolveEnvRefs(parsed, env) → zod。zod strict + fail-loud は
// connector-config.ts / agent-config.ts / channel-doc.ts と同じ流儀。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { resolveEnvRefs } from "./env-ref.js";

export const StoreConfigSchema = z
	.object({
		backend: z.enum(["memory", "sqlite", "firestore"]).default("memory"),
		/** sqlite のときだけ使う。default があるので backend が sqlite 以外でも常に値が入る。 */
		sqlitePath: z.string().default("/tmp/pi-chat-runner/state.db"),
	})
	.strict();

export type StoreConfig = z.infer<typeof StoreConfigSchema>;

/** loadStoreConfig を通した後の設定。connector と異なり store は全項目に既定値が
 * あるため、store ブロック自体が省略されていても StoreConfigSchema.parse({}) 済みの
 * (backend: "memory" ・ sqlitePath: 既定パス) が常に返る。zod の推論型 (StoreConfig)
 * をそのまま公開名として使う。 */
export type ResolvedStoreConfig = StoreConfig;

const AGENT_CONFIG_FILENAME = "agent.yaml";

/** CONFIG_DIR/agent.yaml から `store` ブロックだけを読む。ファイル自体が無い・
 * store ブロックが省略されている場合も StoreConfigSchema.parse({}) を通した
 * default 済みの値 (backend: memory) を返す (connector-config.ts の loadConnectorConfig
 * が {} を返すのとは異なり、store は常に default を効かせる)。env 参照解決は
 * yaml.parse の直後・zod 検証の前に行う。 */
export async function loadStoreConfig(
	configDir: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedStoreConfig> {
	const filePath = join(configDir, AGENT_CONFIG_FILENAME);

	let raw: string;
	try {
		raw = await readFile(filePath, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return StoreConfigSchema.parse({});
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
		return StoreConfigSchema.parse({});
	}
	if (typeof parsed !== "object") {
		throw new Error(`invalid agent config file: ${filePath} (not an object)`);
	}

	const storeRaw = (parsed as Record<string, unknown>).store;
	if (storeRaw === undefined) {
		return StoreConfigSchema.parse({});
	}

	let resolved: unknown;
	try {
		resolved = resolveEnvRefs(storeRaw, env);
	} catch (err) {
		throw new Error(
			`failed to resolve env references in ${filePath} (store):`,
			{ cause: err },
		);
	}

	const result = StoreConfigSchema.safeParse(resolved);
	if (!result.success) {
		const issues = result.error.issues
			.map((issue) => `  - store.${issue.path.join(".")}: ${issue.message}`)
			.join("\n");
		throw new Error(`invalid store config schema in ${filePath}:\n${issues}`);
	}
	return result.data;
}
