// Runner — composition root (docs/design/architecture.md §1, §2, §4)
//
// パイプラインの配線だけを持つ。Ingress ステージ (src/ingress/pipeline.ts) を起こし、
// Gate → Inbox → Dispatcher (src/dispatch/dispatcher.ts) と Egress (EgressRouter) を
// 繋ぐ。どのチャットを配線しているかは知らない — チャット固有のものはすべて
// ChatPlatform (src/chat/platform.ts) の背後にある。
//
// server.ts (CLI/bin) と、npm パッケージとして import して起動するライブラリ利用
// (docs/design/config.md §3) の両方から呼ばれる共通の起動シーケンス。System Config の
// 読み込みと実装選択は server.ts の担当で、ここには組み立て済みのものが渡る。
//
// 組み込み extension (reply/permission-gate/export) の解決と常時注入は Dispatcher
// 自身が行う (src/dispatch/dispatcher.ts) — Runner ⇔ Agent の結線であり、チャットの
// 配線とは別の関心事。

import type { ChatPlatform } from "./chat/platform.js";
import {
  type ClassifierClient,
  GeminiClassifierClient,
} from "./classifier/client.js";
import type { ConfigSource } from "./config/config-source.js";
import { Dispatcher } from "./dispatch/dispatcher.js";
import { EgressRouter } from "./egress/router.js";
import { startIngressPipeline } from "./ingress/pipeline.js";
import type { Logger } from "./logger.js";
import { rootLogger } from "./logger.js";
import type { RuntimeConfig } from "./runtime/config.js";
import type { SharedStore, WorkdirStore } from "./state/agent/interfaces.js";
import type { ControlState } from "./state/control/interfaces.js";

/** classifier gate 用 LLM client のコード既定モデル (config.md §4.1: 未指定時の
 * fallback は Runner の 1 箇所に集約する)。 */
const CODE_DEFAULT_CLASSIFIER_MODEL = "gemini-3.1-flash-lite";

export interface RunnerOptions {
  /** チャット実装の束 (受信の入口・投稿・リアクション・user 解決・整形)。
   * 実装の選択は呼び出し元が行う (createSlackPlatform / createLocalPlatform)。 */
  chat: ChatPlatform;
  /** Control State の Store 群 (inbox / sessions / threads / leases / channels)。state.md §3 */
  controlState: ControlState;
  /** Agent State の保存先 (state.md §6, §8)。shared 未設定なら shared 機能ごと無効。 */
  agentState: {
    workdir: WorkdirStore;
    shared?: SharedStore;
  };
  /** Runtime レイヤの静的設定 (pi のパス・env allowlist・UID 分離・workdir の
   * ルート)。組み立ては server.ts が createRuntimeConfig で行う */
  runtime: RuntimeConfig;
  configSource: ConfigSource;
  /** 1 ターンの上限 (ms)。省略時は Dispatcher の既定 */
  turnTimeoutMs?: number;
  /** 長時間ターンの進捗通知の間隔 (ms)。省略時は Dispatcher の既定、0 で無効 */
  progressNoticeIntervalMs?: number;
  /** lease の TTL (ms)。省略時は Dispatcher の既定 */
  leaseTtlMs?: number;
  /** agent_end 後に追いメッセージを待つ時間 (ms)。省略時は Dispatcher の既定 */
  lingerMs?: number;
  /** classifier gate 用 LLM client の注入口 (主にテスト用)。省略時は
   * GOOGLE_CLOUD_PROJECT があれば GeminiClassifierClient を内部構築する。 */
  classifierClient?: ClassifierClient;
  logger?: Logger;
}

/** ChatPlatform が揃っていることを起動時に確かめる。型では必須だが、JS から
 * 呼ぶライブラリ利用や独自 ChatPlatform 実装では欠けうるため、どれが欠けているか
 * 分かるメッセージで fail-loud する (後段で undefined を呼んで初めて落ちるのを避ける)。 */
const REQUIRED_CHAT_SEAMS = [
  "ingress",
  "poster",
  "reactor",
  "userResolver",
  "fetchMessage",
  "mentionFormat",
  "formatter",
] as const satisfies readonly (keyof ChatPlatform)[];

function assertChatPlatform(chat: ChatPlatform): void {
  const missing = REQUIRED_CHAT_SEAMS.filter(
    (name) => chat?.[name] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `startRunner: options.chat is incomplete; a ChatPlatform must provide ${REQUIRED_CHAT_SEAMS.join("/")}. missing: ${missing.join(", ")}`,
    );
  }
}

/** Dispatcher と Egress を組み立て、Ingress ステージを起動して配線する。
 * ingress の受信開始までで resolve する (以降のイベント処理は継続する)。 */
export async function startRunner(options: RunnerOptions): Promise<void> {
  const logger = options.logger ?? rootLogger.child({ component: "server" });
  const { chat, controlState, configSource, agentState } = options;

  assertChatPlatform(chat);

  // classifier gate 用 LLM client。注入があればそれを使い、なければ
  // GOOGLE_CLOUD_PROJECT があるときだけ GeminiClassifierClient を内部構築する
  // (project 未設定なら undefined = classifier gate を使う channel で createGate が throw)。
  const classifierClient: ClassifierClient | undefined =
    options.classifierClient ??
    (() => {
      const project = process.env.GOOGLE_CLOUD_PROJECT;
      if (project === undefined) return undefined;
      return new GeminiClassifierClient({
        project,
        location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
        defaultModel: CODE_DEFAULT_CLASSIFIER_MODEL,
      });
    })();

  const dispatcher = new Dispatcher({
    configSource,
    controlState,
    router: new EgressRouter({
      poster: chat.poster,
      formatter: chat.formatter,
      logger: logger.child({ component: "egress" }),
    }),
    reactor: chat.reactor,
    logger,
    // mentionFormat は必須 (Dispatcher はプラットフォーム中立で既定値を持たない)。
    // 記法は ChatPlatform が持つ
    mentionFormat: chat.mentionFormat,
    // reaction 起動の対象メッセージ本文の取得 (Gate ステージが Gate 通過後に使う)
    fetchMessage: chat.fetchMessage,
    runtime: options.runtime,
    workdirStore: agentState.workdir,
    // agentState.shared 未設定なら shared 無効
    ...(agentState.shared !== undefined
      ? { sharedStore: agentState.shared }
      : {}),
    // 各 ms 設定は未指定なら Dispatcher の既定を使う
    ...(options.turnTimeoutMs !== undefined
      ? { turnTimeoutMs: options.turnTimeoutMs }
      : {}),
    ...(options.progressNoticeIntervalMs !== undefined
      ? { progressNoticeIntervalMs: options.progressNoticeIntervalMs }
      : {}),
    ...(options.leaseTtlMs !== undefined
      ? { leaseTtlMs: options.leaseTtlMs }
      : {}),
    ...(options.lingerMs !== undefined ? { lingerMs: options.lingerMs } : {}),
    // classifierClient 未構築なら classifier gate 非対応 (createGate が throw する)
    ...(classifierClient !== undefined ? { classifierClient } : {}),
  });

  await startIngressPipeline({
    ingress: chat.ingress,
    userResolver: chat.userResolver,
    sink: {
      message: (event) => dispatcher.handle(event),
      reaction: (event) => dispatcher.handleReaction(event),
    },
    logger,
  });

  logger.info({}, "ingress started; waiting for events");
}
