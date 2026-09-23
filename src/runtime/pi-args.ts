/**
 * pi の起動引数・Permission Model オプション・env allowlist の組み立て
 * (docs/design/runtime.md §3 起動引数、§5.2 Node Permission Model、
 * §5.3 環境変数の allowlist)。すべて純粋関数で、子プロセスの spawn 自体は
 * pi-process.ts が行う。
 */
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import type { PiProcessOptions } from "./pi-process.js";

/**
 * Node Permission Model 経由での起動設定 (pi-tools-and-sandbox.md
 * 「リーズナブルな sandbox レイヤ案」、runtime.md §5.2)。指定時のみ有効になる
 * opt-in。permission の有無に関わらず、解決済みの pi entrypoint を起動できる。
 * bash の子プロセスには効かない (uid 分離が担う層) が、pi 本体の JS 実装ツール
 * (read/write/edit/grep) の fs アクセスを制限する多層防御の一層。
 */
export interface PiPermissionOptions {
  /** pi 本体のエントリポイント JS (例
   * /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js)。
   * `node --permission ... <entrypoint> <pi の引数...>` の形で起動する */
  entrypoint: string;
  /** `--allow-fs-read` に渡すパス群 (グロブ可)。フラグはパスごとに繰り返し指定する
   * (Node 26 で `--allow-fs-write` のカンマ区切りは deprecated warning になり
   * 機能しないため、read/write ともに 1 パス 1 フラグで組み立てる) */
  allowFsRead: string[];
  /** `--allow-fs-write` に渡すパス群 (グロブ可) */
  allowFsWrite: string[];
  /** true なら `--allow-addons` を付ける (既定 false)。native addon (.node) を含む
   * extension (例: pi-smart-fetch の wreq-js) は Permission Model 下でロード自体が
   * 拒否されるため opt-in で緩める。native code は fs チェックを素通りできるので、
   * 有効化するとこのレイヤの隔離は実質 uid 分離だけになる (runtime.md §5.1) */
  allowAddons?: boolean;
}

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
 * piBinary が明示されていればそれを直接呼ぶ。
 * piEntrypoint が指定されていれば permission の有無に関わらず Node.js で起動する。
 * どちらも未指定の場合だけ `pi` を呼ぶ。
 * 指定時は `node --permission --allow-fs-read=... --allow-fs-write=...
 * --allow-child-process <entrypoint> <pi の引数...>` に切り替える
 * (pi-tools-and-sandbox.md 「リーズナブルな sandbox レイヤ案」)。
 * --allow-child-process は常に付ける — bash tool 自体は uid 分離が守る層なので、
 * ここで止めても意味がなく (JS 実装ツールの fs アクセス制限が本レイヤの主目的)、
 * 付けなければ bash tool の spawn 自体が Permission Model に拒否されて動かなくなる。
 * allowFsRead/allowFsWrite はパスごとに 1 フラグに展開する (Node 26 で
 * カンマ区切りは deprecated warning になり機能しないため)。
 */
export function buildSpawnCommand(
  piArgs: string[],
  options: Pick<PiProcessOptions, "piBinary" | "piEntrypoint" | "permission">,
): { command: string; args: string[] } {
  const permission = options.permission;
  if (permission === undefined) {
    if (options.piBinary !== undefined) {
      return { command: options.piBinary, args: piArgs };
    }
    if (options.piEntrypoint !== undefined) {
      return {
        command: process.execPath,
        args: [options.piEntrypoint, ...piArgs],
      };
    }
    return {
      command: "pi",
      args: piArgs,
    };
  }
  const flags: string[] = ["--permission"];
  for (const path of permission.allowFsRead)
    flags.push(`--allow-fs-read=${path}`);
  for (const path of permission.allowFsWrite)
    flags.push(`--allow-fs-write=${path}`);
  flags.push("--allow-child-process");
  // Node 26 の Permission Model はネットワークもデフォルト拒否
  // (fetch が getaddrinfo ERR_ACCESS_DENIED で失敗し LLM 呼び出しが不可能になる)。
  // このレイヤの目的は fs アクセス制限なので net は全面許可する
  flags.push("--allow-net");
  // native addon は既定でロード拒否 (Node 側仕様)。opt-in のときだけ許可する
  if (permission.allowAddons) flags.push("--allow-addons");
  return {
    command: process.execPath,
    args: [...flags, permission.entrypoint, ...piArgs],
  };
}

/**
 * pi 起動時に cwd から `/` まで祖先ディレクトリを 1 段ずつ遡って existsSync する
 * ファイル名 (プロジェクト trust 判定・context ファイル探索。pi
 * dist/core/trust-manager.js の TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES と
 * dist/core/resource-loader.js の loadContextFileFromDir、および `.git` /
 * `.agents/skills` の存在チェックを docker で実測して特定した一覧)。
 * この probe は workdir だけでなく**全ての中間ディレクトリ**
 * (/tmp/pi-chat-runner/sessions/<ch> など) で走るため、workdir の祖先すべてに
 * ついてこのファイル名との直積を `--allow-fs-read` へ展開する必要がある —
 * 1 つでも欠けると existsSync が ERR_ACCESS_DENIED を投げ pi が exit 1 で即死する
 * (`--allow-fs-read=/` や `/*` の一括許可は他ユーザーの読めるファイルまで丸ごと
 * 開けてしまい広すぎるため使わない。docker で確認済み)。
 */
const PI_TRUST_PROBE_FILENAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
  ".git",
  ".pi/settings.json",
  ".pi/extensions",
  ".pi/skills",
  ".pi/prompts",
  ".pi/themes",
  ".pi/SYSTEM.md",
  ".pi/APPEND_SYSTEM.md",
  // dist/migrations.js の migrateCommandsToPrompts が cwd の .pi/commands を
  // existsSync する (prompts への rename 判定)
  ".pi/commands",
  ".agents/skills",
];

/** dir 自身を含む `/` までの祖先ディレクトリ一覧 (純粋関数、テスト対象) */
export function ancestorDirs(dir: string): string[] {
  const dirs: string[] = [];
  let current = dir;
  while (true) {
    dirs.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

/**
 * Node Permission Model 用の allow パス一覧の組み立て (純粋関数、テスト対象)。
 * pi 本体 (npm global の node_modules) / workdir / agent HOME への read を
 * 許可し、write は workdir と agent HOME (+ 任意で /tmp) に限る。extension
 * (reply / permission-gate) の読み込みは `/app` 包括許可の廃止に伴い extraRead
 * 経由で個別に許可する (呼び出し側の runner.ts が積む)。実際の allow 集合は
 * docker 起動での実測 (このモジュールのコメント、pi-tools-and-sandbox.md) に
 * 基づく最小構成。
 */
export function buildPiPermissionOptions(options: {
  /** pi 本体のエントリポイント JS の絶対パス */
  entrypoint: string;
  /** pi 本体の node_modules ルート (既定は entrypoint の npm global レイアウトから
   * 推測できないため必須。例 /usr/local/lib/node_modules) */
  nodeModulesDir: string;
  /** セッションの workdir (cwd)。read/write 両方を許可する */
  workdir: string;
  /** pi の HOME (常に agentHome)。~/.pi 等の読み書きに要る */
  home: string;
  /** 追加で write を許可したいパス (例 "/tmp/*"）。既定なし */
  extraWrite?: string[];
  /** 追加で read を許可したいパス (例 GOOGLE_APPLICATION_CREDENTIALS のファイル
   * パス、または --extension に渡す extension ファイルのディレクトリ)。HOME を
   * agentHome に固定するとローカルのユーザー ADC ($HOME/.config/gcloud) は HOME
   * 経由で見えなくなるため、明示指定されたファイルだけ個別に read を許可する用途。
   * `/app` 配下を包括的に許可することはしないため、extension を読ませるには
   * 呼び出し側 (runner.ts) が extensionPaths の dirname をここへ積む必要がある。
   * 既定なし */
  extraRead?: string[];
  /** `--allow-addons` の付与 (PiPermissionOptions.allowAddons へ素通し)。既定 false */
  allowAddons?: boolean;
}): PiPermissionOptions {
  return {
    entrypoint: options.entrypoint,
    ...(options.allowAddons !== undefined
      ? { allowAddons: options.allowAddons }
      : {}),
    allowFsRead: [
      `${options.nodeModulesDir}/*`,
      `${options.workdir}/*`,
      `${options.home}/*`,
      // workdir の全祖先 (workdir 自身は上の glob で足りるが重複しても無害) ×
      // trust probe ファイル名の直積。中間ディレクトリの existsSync を通すため
      ...ancestorDirs(options.workdir).flatMap((dir) =>
        PI_TRUST_PROBE_FILENAMES.map((name) => join(dir, name)),
      ),
      // pi の bash tool はシェル解決で existsSync("/bin/bash") を呼ぶ
      // (dist/utils/shell.js の getShellConfig)。Permission Model 下では
      // 未許可パスの existsSync は例外になるため、許可しないと bash tool が
      // コマンド内容にかかわらず全て失敗する。/bin/sh はそのフォールバック
      "/bin/bash",
      "/bin/sh",
      // bash tool の出力が 50KB (DEFAULT_MAX_BYTES) を超えると pi は
      // tmpdir()/pi-bash-<id>.log へスピルする (dist/core/bash-executor.js)。
      // 許可しないと WriteStream の unhandled 'error' で pi がツール実行中に即死する。
      // buildPiEnv は TMPDIR を渡さないため pi から見た tmpdir() は常に /tmp
      ...piBashSpillPatterns(),
      ...(options.extraRead ?? []),
    ],
    allowFsWrite: [
      `${options.workdir}/*`,
      `${options.home}/*`,
      ...piBashSpillPatterns(),
      ...(options.extraWrite ?? []),
    ],
  };
}

/** pi の bash 出力スピルファイル (/tmp/pi-bash-*.log) の許可パターン。
 * macOS では /tmp が /private/tmp への symlink で、Permission Model の照合は
 * パスの実体化タイミングで揺れるため realpath 側も併記する */
function piBashSpillPatterns(): string[] {
  const patterns = new Set<string>(["/tmp/pi-bash-*"]);
  try {
    patterns.add(join(realpathSync("/tmp"), "pi-bash-*"));
  } catch {
    // /tmp が無い環境はそのまま (コンテナでは /tmp は実体)
  }
  return [...patterns];
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
