// GateEvaluator — パイプラインの Gate ステージ (docs/design/architecture.md §2, §6)。
//
// ChatEvent 1 件を受けて「この Channel でこのイベントは Session を起こしてよいか」を
// 決め、通したイベントを Dispatcher が扱える InboundMessage の形にして返す。
// docs/design/message-dispatch.md §1 (全体の流れ)、§2 (実行中 Session への配送と Gate)、
// docs/design/config.md §4 (trigger.when のブール木と既定)。
//
// 責務の境界:
// - 判定の順序 (Channel 有効状態 → 実行中 Session → Gate 木) をここに集約する。
//   Dispatcher は個々の Gate を呼ばず、admit() だけを使う。
// - Session / Dispatcher を import しない。Session の選択 (sessionKey の導出) と
//   実行中 Session への配送は Dispatcher の担当なので、admit() のコールバック
//   (resolveSessionKey / deliverToRunningSession) 越しに呼ぶ。
// - reaction の対象メッセージ本文の取得 (fetchMessage) は Ingress 寄りの操作だが、
//   Gate を通った reaction を message と同じ形へ均すために Gate が要求する情報なので
//   ここで行う (message-dispatch.md §1)。

import type { ClassifierClient } from "../classifier/client.js";
import type { ResolvedChannel } from "../config/config-source.js";
import { type ConfigSource, DM_CHANNEL } from "../config/config-source.js";
import type {
  ChatEvent,
  InboundMessage,
  ReactionEvent,
} from "../ingress/chat-event.js";
import type { Logger } from "../logger.js";
import type { ControlState } from "../state/control/interfaces.js";
import {
  buildWhen,
  defaultWhen,
  type EvaluableNode,
  evaluateWhen,
  type GateDeps,
} from "./gate.js";

/** reaction の対象メッセージ本文を取得する port (message-dispatch.md §1「人間による
 * リアクション起動」)。chat 実装が Slack conversations.replies/history 等で提供する。
 * 見つからない/取得失敗時は null。 */
export type FetchMessage = (
  channelId: string,
  messageId: string,
) => Promise<FetchedMessage | null>;

export interface FetchedMessage {
  text: string;
  /** 対象メッセージが属するスレッドの thread_ts。トップレベル発言なら undefined。 */
  threadTs?: string;
  /** 発言者 (表示名解決は任意)。 */
  userId?: string;
}

/** Gate ステージへ渡す 1 イベント分の文脈。Session の選択と実行中 Session への
 * 配送は Dispatcher の担当なので、Gate は 2 つのコールバック越しにそれを呼ぶだけで
 * レジストリも導出規則も知らない (message-dispatch.md §2, §3)。 */
export interface GateRequest {
  event: ChatEvent;
  /** 実行中判定と配送に使う sessionKey を返す (Dispatcher の Session 選択) */
  resolveSessionKey: (message: InboundMessage) => Promise<string> | string;
  /** 実行中 (起動中を含む) Session があれば enqueue → steer して true を返す
   * Dispatcher 側の配送。Gate を省略する経路 (trigger.whileRunning: passthrough) で
   * 呼ばれる。実行中 Session が無ければ false を返し、Gate 木の評価へ進む */
  deliverToRunningSession: (
    message: InboundMessage,
    sessionKey: string,
  ) => Promise<boolean>;
  /** Channel 無効中でも Gate 評価まで通す (`/enable` `/disable` の復帰経路、
   * session-model.md §5.2)。既定 false */
  bypassChannelDisabled?: boolean;
}

/** Gate ステージの判定結果。
 * - `admit`: Gate を通過したので Dispatcher が Session を起動/再開してよい。
 *   `message` は正規化済みイベント (reaction なら fetch 済みの synthetic
 *   InboundMessage)、`sessionKey` は resolveSessionKey の結果
 * - `drop`: ここで処理が終わった (Gate 非通過で捨てた、または実行中 Session への
 *   配送で完了した)。どちらもログは Gate / 配送側で済んでいる */
export type GateOutcome =
  | {
      kind: "admit";
      message: InboundMessage;
      channel: ResolvedChannel | null;
      sessionKey: string;
    }
  | { kind: "drop" };

export interface GateEvaluatorOptions {
  configSource: ConfigSource;
  /** Channel 有効状態 (/enable /disable) の参照先。state.md §3 */
  controlState: ControlState;
  /** reaction の対象メッセージ本文の取得。Gate を通過したときにだけ呼ぶ */
  fetchMessage: FetchMessage;
  logger: Logger;
  /** classifier gate 用の LLM client。省略時は classifier gate を使う channel で
   * createGate が throw する (config.md §4.1)。 */
  classifierClient?: ClassifierClient;
}

/** Channel 有効状態 → 実行中 Session → Gate 木、の順で 1 イベントを判定する
 * (message-dispatch.md §1)。message と reaction はこの同じ段の並びを通り、
 * reaction だけが Gate 通過後に本文取得 (materialize) を挟む。 */
export class GateEvaluator {
  readonly #configSource: ConfigSource;
  readonly #controlState: ControlState;
  readonly #fetchMessage: FetchMessage;
  readonly #logger: Logger;
  readonly #classifierClient: ClassifierClient | undefined;

  constructor(options: GateEvaluatorOptions) {
    this.#configSource = options.configSource;
    this.#controlState = options.controlState;
    this.#fetchMessage = options.fetchMessage;
    this.#logger = options.logger;
    this.#classifierClient = options.classifierClient;
  }

  /** Channel Config の解決 (DM は予約名 "dm" を全 DM 共通で参照する。config.md §3.1)。
   * YAML の壊れで受信ループを止めないため、失敗時は null (既定動作 = mention 起動 /
   * DM は無効) に落とす。Dispatcher は Gate 判定の前に Session の選択で Channel Config
   * を必要とするため公開する */
  async channelConfig(
    channelId: string,
    isDm: boolean,
  ): Promise<ResolvedChannel | null> {
    try {
      return await this.#configSource.channel(isDm ? DM_CHANNEL : channelId);
    } catch (err) {
      this.#logger.warn({ channelId, err }, "failed to load channel config");
      return null;
    }
  }

  /** チャンネルが /disable で無効化されているか (session-model.md §5.2)。
   * channel 不在 = enabled (既定)。DM 予約名でなく実 channelId で管理する
   * (メッセージ側は実 channelId で判定するため、ChannelConfig の DM 束ねとは別軸)。
   * debounce 待機中の再チェック (message-dispatch.md §4) から Dispatcher も使う */
  async isChannelDisabled(channelId: string): Promise<boolean> {
    return (
      (await this.#controlState.channels.get(channelId))?.enabled === false
    );
  }

  /** bot 投稿 (自己エコーは Ingress で除外済み) を受け付けるか。allowBots opt-in の
   * channel でのみ Gate 評価・steer に乗せる (config.md §4.3) */
  allowsBots(channel: ResolvedChannel | null): boolean {
    return channel?.trigger?.allowBots === true;
  }

  /** イベント 1 件を Gate ステージに通す。段の並びは message / reaction 共通で
   * Channel 有効状態 → 実行中 Session → Gate 木 (message-dispatch.md §1)。
   * reaction は sessionKey が本文取得の後にしか決まらないため実行中 Session の段では
   * 短絡せず、Gate 通過後にだけ対象メッセージ本文を取得して message の形へ均す
   * (無関係なリアクションごとに chat API を叩かないため)。このため
   * trigger.whileRunning は message 経路にのみ効く。 */
  async admit(request: GateRequest): Promise<GateOutcome> {
    const { event } = request;
    const channelId = event.conversation?.channelId;
    if (channelId === undefined) return { kind: "drop" };
    const isDm = event.conversation?.isDm === true;
    const channel = await this.channelConfig(channelId, isDm);
    const isReaction = event.kind === "reaction";

    // 1. Channel 有効状態 (session-model.md §5.2)。無効中は steer も Gate 評価
    // (classifier の LLM 呼び出し含む) も行わず捨てる。`/enable` `/disable` だけは
    // 復帰経路として素通りさせ、Gate (mention) を経て処理する
    if (
      request.bypassChannelDisabled !== true &&
      (await this.isChannelDisabled(channelId))
    ) {
      this.#logger.info(
        { channelId, kind: event.kind },
        "event dropped (channel disabled)",
      );
      return { kind: "drop" };
    }

    // 2. 実行中 Session (message-dispatch.md §2)。message は既定
    // (trigger.whileRunning: passthrough) で Gate を省略し、実行中 Session への
    // 追加指示として配送する — すでに始まっている会話への入力を起動条件で再び
    // 篩にかけないため。`evaluate` ではここを飛ばして毎回 Gate を評価し、通過した
    // 場合に同じ配送へ回す
    if (!isReaction) {
      const message = event as InboundMessage;
      const sessionKey = await request.resolveSessionKey(message);
      if (this.#whileRunning(channel) === "passthrough") {
        if (await request.deliverToRunningSession(message, sessionKey)) {
          return { kind: "drop" };
        }
      }
      // 3. Gate 木の評価 (config.md §4)
      const passed = await this.#gatePasses(
        event,
        channel,
        isDm,
        channelId,
        sessionKey,
      );
      if (!passed) return { kind: "drop" };
      // whileRunning: evaluate で Gate を通ったメッセージも、実行中 Session が
      // あればそこへ配送する (起動しない)
      if (
        this.#whileRunning(channel) === "evaluate" &&
        (await request.deliverToRunningSession(message, sessionKey))
      ) {
        return { kind: "drop" };
      }
      return { kind: "admit", message, channel, sessionKey };
    }

    // 3. Gate 木の評価 (reaction。config.md §4 の kind: reaction)
    if (!(await this.#gatePasses(event, channel, isDm, channelId))) {
      return { kind: "drop" };
    }
    // 4. Gate を通過した reaction だけ本文を取得して message の形へ均す
    const message = await this.#materializeReaction(event as ReactionEvent);
    if (message === null) return { kind: "drop" };
    const sessionKey = await request.resolveSessionKey(message);
    if (await request.deliverToRunningSession(message, sessionKey)) {
      return { kind: "drop" };
    }
    return { kind: "admit", message, channel, sessionKey };
  }

  /** Gate 木 (trigger.when) の評価と、発火/非発火のログ (config.md §4)。 */
  async #gatePasses(
    event: ChatEvent,
    channel: ResolvedChannel | null,
    isDm: boolean,
    channelId: string,
    sessionKey?: string,
  ): Promise<boolean> {
    const isReaction = event.kind === "reaction";
    const decision = await evaluateWhen(this.#resolveWhen(channel, isDm), {
      event,
    });
    const fields = {
      channelId,
      ...(sessionKey !== undefined ? { sessionKey } : {}),
      reason: decision.reason,
    };
    if (!decision.trigger) {
      this.#logger.debug(
        fields,
        isReaction ? "reaction gate not triggered" : "gate not triggered",
      );
      return false;
    }
    this.#logger.info(
      fields,
      isReaction ? "reaction gate triggered" : "gate triggered",
    );
    return true;
  }

  /** trigger.whileRunning の実効値 (config.md §4.4 / message-dispatch.md §2)。
   * `passthrough` (既定) は実行中 Session への message で Gate を省略する。
   * `evaluate` は実行中でもメッセージごとに Gate を評価する */
  #whileRunning(channel: ResolvedChannel | null): "passthrough" | "evaluate" {
    return channel?.trigger?.whileRunning ?? "passthrough";
  }

  /** reaction を message と同じ形 (InboundMessage) へ均す (message-dispatch.md §1)。
   * 取得できなければ null */
  async #materializeReaction(
    event: ReactionEvent,
  ): Promise<InboundMessage | null> {
    const channelId = event.conversation.channelId;
    const fetched = await this.#fetchMessage(channelId, event.targetMessageId);
    if (fetched === null) {
      this.#logger.warn(
        { channelId, targetMessageId: event.targetMessageId },
        "reaction target message not found",
      );
      return null;
    }
    return {
      kind: "message",
      id: event.targetMessageId,
      conversation: {
        channelId,
        ...(fetched.threadTs !== undefined
          ? { threadTs: fetched.threadTs }
          : {}),
        ...(event.conversation.isDm ? { isDm: true } : {}),
      },
      sender: event.sender,
      text: fetched.text,
      mentionsBot: false,
      attachments: [],
      timestamp: event.timestamp,
      raw: event.raw,
      metadata: {},
    };
  }

  #resolveWhen(
    channel: ResolvedChannel | null,
    isDm: boolean,
  ): EvaluableNode[] {
    const deps: GateDeps = {
      ...(this.#classifierClient !== undefined
        ? { classifierClient: this.#classifierClient }
        : {}),
      logger: this.#logger,
    };
    if (channel?.trigger === undefined) {
      // channel なし / trigger 未設定は既定 = mention のみ、DM は disabled
      // (起動しない) (config.md §4.1, §3.1)
      return buildWhen(defaultWhen(isDm), deps);
    }
    return buildWhen(channel.trigger.when, deps);
  }
}
