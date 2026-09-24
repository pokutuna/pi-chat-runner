/**
 * pi の起動引数・env allowlist の組み立て (docs/design/runtime.md §3 起動引数、
 * §5.3 環境変数の allowlist)。すべて純粋関数で、子プロセスの spawn 自体は
 * pi-process.ts が行う。
 */
import type { PiProcessOptions } from "./pi-process.js";
import type { SandboxSpawnConfig } from "./sandbox.js";

/** API キー環境変数ではなく ADC (ambient credentials) で認証する provider の一覧。
 * pi-ai の認証可否判定 (env-api-keys.js) は ADC ファイルの存在チェックを行うため、
 * ファイルを作らない Cloud Run のメタデータサーバー ADC では通らない。値は pi-ai が
 * 定義する迂回用 marker 文字列 (secret ではない)。ADC 対応 provider を増やすときは
 * ここに追記する (例: amazon-bedrock)。 */
const ADC_MARKER_PROVIDERS = new Map<string, string>([
  ["google-vertex", "gcp-vertex-credentials"],
]);

/** spawn 引数の組み立て (純粋関数、テスト対象) */
export function buildPiArgs(
  options: Pick<
    PiProcessOptions,
    | "sessionPath"
    | "extensionPaths"
    | "model"
    | "appendSystemPrompt"
    | "skillPaths"
    | "tools"
    | "excludeTools"
  >,
): string[] {
  const args = ["--mode", "rpc", "--session", options.sessionPath];
  // pi は起動時にバージョンチェックと install telemetry の外部通信を行う
  // (dist/main.js の offlineMode 判定、docs/settings.md「Telemetry and update
  // checks」)。毎 mention ごとに spawn する本設計ではその都度の通信が無駄で
  // コールドスタート遅延の要因になるため常時止める。LLM 呼び出し (provider API)
  // には影響しない (research/pi-config.md 含意 4)
  args.push("--offline");
  // pi の CLI は --extension を複数回受け付けるため、パスごとに 1 フラグ展開する
  // (reply + permission-gate を常時両方注入するため)
  for (const extensionPath of options.extensionPaths)
    args.push("--extension", extensionPath);
  // model は `provider/model-id[:thinking]` の canonical 形式 (channel-config.ts で検証済み)。
  // provider 推論・thinking パースは pi の resolveCliModel に委譲する (--provider は
  // 渡さない)。ADC 系 provider だけは認証可否判定の都合で prefix を見る (下記)
  if (options.model) args.push("--model", options.model);
  // ADC 系 provider の認証可否判定は「ADC ファイルの存在チェック」なので、Cloud Run の
  // メタデータサーバー ADC (ファイルを作らない) では "No API key found" になる。
  // pi-ai が定義する marker 文字列を明示的に渡すとこのゲートを迂回でき、marker は
  // provider 側 (resolveApiKey) で捨てられて ADC 経路で実認証される (secret ではない)。
  // それ以外の provider の認証は agent.env で渡す環境変数 (OPENROUTER_API_KEY 等) を
  // pi 自身が拾う (env-api-keys の固定テーブル)。runner は判定に関与しない
  const providerPrefix = options.model?.split("/")[0];
  const adcMarker =
    providerPrefix !== undefined
      ? ADC_MARKER_PROVIDERS.get(providerPrefix)
      : undefined;
  if (adcMarker !== undefined) args.push("--api-key", adcMarker);
  if (options.appendSystemPrompt)
    args.push("--append-system-prompt", options.appendSystemPrompt);
  for (const skillPath of options.skillPaths ?? [])
    args.push("--skill", skillPath);
  // --tools は extension ツールにも効くため、reply が落ちると返信経路
  // (runtime.md §4.1 の常時注入方針) が壊れる。allowlist を指定するチャンネルでも
  // reply だけは黙って補ってしまい、excludeTools に reply を書いても無視する
  if (options.tools !== undefined && options.tools.length > 0) {
    const tools = options.tools.includes("reply")
      ? options.tools
      : [...options.tools, "reply"];
    args.push("--tools", tools.join(","));
  }
  if (options.excludeTools !== undefined) {
    const rest = options.excludeTools.filter((tool) => tool !== "reply");
    if (rest.length > 0) args.push("--exclude-tools", rest.join(","));
  }
  return args;
}

/**
 * 実際に spawn する command/args の組み立て (純粋関数、テスト対象)。
 * piBinary が明示されていればそれを直接呼ぶ。piEntrypoint が指定されていれば
 * Runner と同じ Node.js で起動する。どちらも未指定の場合だけ `pi` を呼ぶ。
 */
export function buildSpawnCommand(
  piArgs: string[],
  options: Pick<PiProcessOptions, "piBinary" | "piEntrypoint">,
): { command: string; args: string[] } {
  if (options.piBinary !== undefined) {
    return { command: options.piBinary, args: piArgs };
  }
  if (options.piEntrypoint !== undefined) {
    return {
      command: process.execPath,
      args: [options.piEntrypoint, ...piArgs],
    };
  }
  return { command: "pi", args: piArgs };
}

/**
 * buildSpawnCommand の結果を srt CLI で包む (純粋関数、テスト対象。runtime.md §5.5)。
 * `node <srt cli.js> [--debug] --settings <file> -- <command> <args...>` の形。
 * srt はライブラリではなく CLI で挟む — srt のネットワーク許可リストはプロセス単位で
 * 1 つしか持てないため、Channel ごとに違う許可リストを与えるには Session ごとに srt
 * プロセスを立てる必要がある。argv は srt がシェル用にクォートして子に渡す。
 */
export function wrapWithSrt(
  inner: { command: string; args: string[] },
  sandbox: SandboxSpawnConfig,
): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [
      sandbox.srtEntrypoint,
      ...(sandbox.debug ? ["--debug"] : []),
      "--settings",
      sandbox.settingsPath,
      "--",
      inner.command,
      ...inner.args,
    ],
  };
}

/**
 * env の allowlist 構築 (純粋関数、テスト対象)。
 * process.env を丸ごと継承せず、PATH / HOME + 明示指定分のみを渡す
 * (docs/design/runtime.md §5.3)。
 */
export function buildPiEnv(
  baseEnv: Record<string, string | undefined>,
  extraEnv?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME"]) {
    const value = baseEnv[key];
    if (value !== undefined) env[key] = value;
  }
  if (extraEnv) Object.assign(env, extraEnv);
  return env;
}
