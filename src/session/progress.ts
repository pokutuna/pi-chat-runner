import type { EgressRouter } from "../egress/router.js";
import type { Logger } from "../logger.js";
import { preview } from "./pi-events.js";

/** 進捗通知でツール名ごとに絵文字を出し分ける (progress-notice.md)。
 * reply は呼び出し元 (tool_execution_start ハンドラ) で除外済みなのでここには
 * 来ない。分類が当たらないツールは既定の :gear: にフォールバックする。bash は
 * 頻出のため呼び出しごとに候補からランダムに1つ選び、単調な見た目にならない
 * ようにする */
export function progressEmoji(toolName: string): string {
  switch (toolName) {
    case "bash":
      return (
        BASH_EMOJIS[Math.floor(Math.random() * BASH_EMOJIS.length)] ??
        ":computer:"
      );
    case "read":
    case "grep":
    case "find":
    case "ls":
      return ":mag:";
    case "write":
    case "edit":
      return ":memo:";
    default:
      return ":gear:";
  }
}

const BASH_EMOJIS = [
  ":computer:",
  ":keyboard:",
  ":zap:",
  ":gear:",
  ":hammer_and_wrench:",
  ":rocket:",
  ":robot_face:",
  ":satellite:",
];

/** pi 組み込みツール (bash/read/write/edit/grep/find/ls) の主要な引数キー1つの
 * 値だけを取り出す。JSON.stringify のキー名込み表示 (`{"command":"..."}`) は
 * 進捗通知としては冗長なため。組み込み以外の (extension 由来の) ツールは
 * キー構成を把握できないので preview() の汎用フォールバックに委ねる */
export function toolArgsPreview(
  toolName: string,
  args: unknown,
  maxChars: number,
): string {
  const key = BUILTIN_TOOL_PRIMARY_ARG_KEY[toolName];
  if (key === undefined) return preview(args, maxChars);
  const value =
    typeof args === "object" && args !== null
      ? (args as Record<string, unknown>)[key]
      : undefined;
  return value === undefined ? "" : preview(value, maxChars);
}

const BUILTIN_TOOL_PRIMARY_ARG_KEY: Record<string, string> = {
  bash: "command",
  read: "path",
  ls: "path",
  write: "path",
  edit: "path",
  grep: "pattern",
  find: "pattern",
};

export interface ProgressNoticeOptions {
  sessionKey: string;
  router: EgressRouter;
  /** 長時間ターンの進捗通知の間隔 (progress-notice.md)。0 なら機能自体を無効化する */
  intervalMs: number;
  logger: Logger;
}

/** 長時間ターンの進捗通知 (progress-notice.md)。tool_execution_start/end の購読だけで
 * 状態を更新し (LLM 呼び出し・session.jsonl を経由しない)、intervalMs 間隔で
 * currentTool のスナップショットを Slack へ投稿/更新する。usage の集計は対象外
 * (ActiveSession に残す) */
export class ProgressNotice {
  /** 直近に開始した、または直近に完了したツール呼び出し。tool_execution_start/end の
   * 購読だけで更新する (LLM 呼び出し・session.jsonl を経由しない、progress-notice.md)。
   * emoji は tool_execution_start 時点で確定させる (bash は候補からランダムに選ぶため、
   * タイマー発火のたびに選び直すと同じ呼び出し中に表示が変わってしまう)。reply は
   * 進捗表示の対象外なのでここには反映されない (progress-notice.md) */
  #currentTool:
    | { name: string; emoji: string; argsPreview: string }
    | undefined;
  /** このセッションでの tool_execution_start 累計回数 (progress-notice.md の
   * 進捗表示用。ターンをまたいで積算する)。reply は対象外なので含めない */
  #toolCallCount = 0;
  /** 直前に進捗通知として送信したテキスト (progress-notice.md)。同じ内容なら
   * tick をスキップし、Slack API を呼ばない (状況が進んでいないのに更新し続けない) */
  #lastText: string | undefined;
  /** 進捗通知タイマー (progress-notice.md)。prompt/steer 送信ごとにリセットし、
   * agent_end 冒頭でクリアする (turnTimeoutTimer と同じ寿命管理) */
  #timer: NodeJS.Timeout | undefined;

  /** 現在の進捗投稿先キー。新規ターンの kick (start/#promptPending) のたびに
   * そのターンの先頭発言の thread_key へ差し替える (reset の引数)。steer
   * (実行中セッションへの追い討ち) では差し替えない — session.affinity 合流や
   * session.mode=channel で、後から合流した発言の宛先が最初のスレッドと
   * 異なっても、進捗メッセージは「そのターンを起こした先頭発言のスレッド」に
   * 留め続ける (RUNNER_TODO.md「progress-notice が affinity 合流時に別スレッドへ
   * reply すると上書きされず残る」)。取り残された進捗メッセージ自体は次に
   * そのスレッドへ reply が届いたときに通常どおり回収される */
  #progressKey: string;
  readonly #router: EgressRouter;
  readonly #intervalMs: number;
  readonly #logger: Logger;

  constructor(options: ProgressNoticeOptions) {
    this.#progressKey = options.sessionKey;
    this.#router = options.router;
    this.#intervalMs = options.intervalMs;
    this.#logger = options.logger;
  }

  /** tool_execution_start の状態更新 (reply 除外は呼び出し元で判定済み)。count を
   * 積み、currentTool を今回のツールのスナップショットで更新する */
  onToolStart(toolName: string, args: unknown): void {
    this.#toolCallCount += 1;
    this.#currentTool = {
      name: toolName,
      emoji: progressEmoji(toolName),
      argsPreview: toolArgsPreview(toolName, args, 60),
    };
  }

  /** 進捗通知タイマーをリセットする (prompt/steer 送信ごとに呼ぶ。既存タイマーが
   * あれば止めて張り直す)。turnTimeoutTimer と同じ寿命管理パターン
   * (progress-notice.md)。間隔ごとに currentTool のスナップショットを投稿/更新する。
   *
   * newTurnKey: 新規ターンの kick (start/#promptPending) から呼ぶときだけ、
   * そのターンの先頭発言の thread_key を渡す。省略時 (steer) は現在の進捗キーを
   * 維持する */
  reset(newTurnKey?: string): void {
    if (newTurnKey !== undefined) this.#progressKey = newTurnKey;
    const progressKey = this.#progressKey;
    this.clear();
    // 新しいターンの内容と比較できるよう、前ターン分の記憶は引き継がない
    this.#lastText = undefined;
    // 前ターンの reply 配達で閉じた進捗レーン (router.ts progressClosed) を
    // 新ターン開始時に再び開く。fire-and-forget — 失敗しても次の notifyProgress
    // が warn を出すだけで、新ターンの進捗表示自体はタイマーが担う
    void this.#router.reopenProgress(progressKey).catch((err) => {
      this.#logger.warn({ progressKey, err }, "failed to reopen progress lane");
    });
    if (this.#intervalMs === 0) return;
    const timer = setInterval(() => {
      const tool = this.#currentTool;
      const count = this.#toolCallCount;
      const text =
        tool === undefined
          ? `:thinking_face: ... (step ${count})`
          : tool.argsPreview === ""
            ? `${tool.emoji} \`${tool.name}\` ... (step ${count})`
            : `${tool.emoji} \`${tool.name}\` \`${tool.argsPreview}\` ... (step ${count})`;
      // 前回送信時から状況が進んでいなければ何もしない (Slack API を呼ばない)
      if (text === this.#lastText) return;
      this.#lastText = text;
      this.#router.notifyProgress(progressKey, text).catch((err) => {
        this.#logger.warn({ progressKey, err }, "progress notice failed");
      });
    }, this.#intervalMs);
    timer.unref();
    this.#timer = timer;
  }

  clear(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /** 現在の進捗投稿先キー (#progressKey)。セッション終了時の router.clearProgress
   * はこれを使う必要がある — reset(newTurnKey) で sessionKey から差し替わって
   * いる場合、呼び出し元が sessionKey 固定で clearProgress すると実際に使って
   * いたキーの後始末が漏れる */
  get currentKey(): string {
    return this.#progressKey;
  }
}
