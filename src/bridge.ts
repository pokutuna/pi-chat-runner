// startBridge — composition root (SessionRunner の組み立てと Ingress の配線)。
//
// server.ts (CLI/bin) と、npm パッケージとして import して起動するライブラリ利用
// (docs/design/config.md §6) の両方から呼ばれる共通の起動シーケンス。env パース・
// composition の分離については server.ts のコメントを参照。
//
// 組み込み extension (reply/permission-gate/export) の解決と常時注入は SessionRunner
// 自身が行う (src/session/runner.ts)。プラットフォーム非依存の Runner ⇔ pi 結線で
// あり、bridge (Slack 専用の composition root) の関心事ではない。

import { basename } from "node:path";

import type { WebClient } from "@slack/web-api";

import {
  type ClassifierClient,
  GeminiClassifierClient,
} from "./classifier/client.js";
import type { ConfigSource } from "./config/config-source.js";
import { toMrkdwn } from "./egress/mrkdwn.js";
import { Reactions } from "./egress/reactions.js";
import type { ChatPoster } from "./egress/router.js";
import { EgressRouter } from "./egress/router.js";
import type { ChatEvent, InboundMessage } from "./ingress/chat-event.js";
import type { Ack, Ingress } from "./ingress/ingress.js";
import { SlackUserResolver } from "./ingress/slack/user-resolver.js";
import { enrichEvent, type UserResolver } from "./ingress/user-resolver.js";
import type { Logger } from "./logger.js";
import { rootLogger } from "./logger.js";
import type { FetchMessage, PiPermissionConfig } from "./session/runner.js";
import { SessionRunner } from "./session/runner.js";
import type { StateStore } from "./store/state/interfaces.js";
import { createWorkdirStorage, type WorkdirStorage } from "./store/workdir.js";

/** classifier gate 用 LLM client のコード既定モデル (config.md §2.3: 未指定時の
 * fallback は bridge の 1 箇所に集約する)。 */
const CODE_DEFAULT_CLASSIFIER_MODEL = "gemini-3.1-flash-lite";

export interface BridgeOptions {
  /** 受信の入口 (Socket Mode / Events API / 呼び出し側独自の実装)。ライブラリ利用の
   * 本命 seam — 別の Slack app 実装から独自 Ingress を差し込める。 */
  eventSource: Ingress;
  /** 返信投稿 (chat.postMessage) と reaction (reactions.add) に使う。 */
  web: WebClient;
  store: StateStore;
  configSource: ConfigSource;
  turnTimeoutMs?: number;
  progressNoticeIntervalMs?: number;
  /** classifier gate 用 LLM client の注入口 (主にテスト用)。省略時は
   * GOOGLE_CLOUD_PROJECT があれば GeminiClassifierClient を内部構築する。 */
  classifierClient?: ClassifierClient;
  /** 明示的に差し替える pi バイナリ。テストや埋め込み用途向け */
  piBinary?: string;
  /** 解決済みの pi 本体 entrypoint JS。permission の有無に関わらず使用する */
  piEntrypoint?: string;
  extraEnv?: Record<string, string>;
  archiveDir?: string;
  agentUid?: number;
  agentGid?: number;
  agentHome?: string;
  piPermission?: PiPermissionConfig;
  logger?: Logger;
  /** 返信投稿の注入口。省略時は web (WebClient) の chat.postMessage から内部構築する。 */
  poster?: ChatPoster;
  /** reaction 操作の注入口。省略時は web (WebClient) の reactions.add から内部構築する。 */
  reactions?: Reactions;
  /** UserID → 表示名解決の注入口。省略時は web (WebClient) の users.info から内部構築する。 */
  userResolver?: UserResolver;
  /** workdir の保存先の注入口。省略時は archiveDir があれば CopyWorkdirStorage を、
   * なければ境界退避なしで内部構築する。指定時は archiveDir より優先される。 */
  workdirStorage?: WorkdirStorage;
}

/** SessionRunner を組み立て、eventSource を起動して配線する。呼び出し元 (server.ts の
 * main、または import した Slack app 実装) が env パースを済ませた後に呼ぶ。 */
export async function startBridge(options: BridgeOptions): Promise<void> {
  const logger = options.logger ?? rootLogger.child({ component: "server" });
  const { web, eventSource, store, configSource } = options;

  // メッセージ描画時の UserID → 表示名解決 (renderEvent / mention 展開)。
  // 注入があればそれを使い、なければ web (WebClient) の users.info から内部構築する
  const resolver: UserResolver =
    options.userResolver ??
    new SlackUserResolver({
      usersInfo: (userId) => web.users.info({ user: userId }),
    });

  // 注入があればそれを使い、なければ web (WebClient) から内部構築する。files 指定時は
  // files.uploadV2 (initial_comment に text を乗せる)、無指定時は従来の chat.postMessage。
  // messageId (Slack の ts) は進捗通知 (progress-notice.md) の updateMessage が使う —
  // files.uploadV2 は投稿本体のメッセージ ts を返さないため、その場合は messageId 抽象を
  // 持たない (updateMessage の対象にはならない。進捗通知は files を使わないので実害はない)
  const poster: ChatPoster = options.poster ?? {
    async postMessage(channelId, text, threadTs, files) {
      if (files !== undefined && files.length > 0) {
        await web.files.uploadV2({
          channel_id: channelId,
          ...(threadTs !== undefined ? { thread_ts: threadTs } : {}),
          ...(text ? { initial_comment: text } : {}),
          file_uploads: files.map((path) => ({
            file: path,
            filename: basename(path),
          })),
        });
        return { messageId: "" };
      }
      const res = await web.chat.postMessage({
        channel: channelId,
        text,
        ...(threadTs !== undefined ? { thread_ts: threadTs } : {}),
      });
      return { messageId: res.ts ?? "" };
    },
    async updateMessage(channelId, messageId, text) {
      await web.chat.update({ channel: channelId, ts: messageId, text });
    },
  };
  const reactions =
    options.reactions ??
    new Reactions({
      add: (args) => web.reactions.add(args),
    });
  // reaction トリガーの対象メッセージ本文取得 (session-model.md §5「人間による
  // リアクション起動」)。conversations.replies は ts が親でもスレッド返信でも、
  // その ts のメッセージ自身を先頭で返す
  const fetchMessage: FetchMessage = async (channelId, ts) => {
    try {
      const res = await web.conversations.replies({
        channel: channelId,
        ts,
        limit: 1,
      });
      const msg = res.messages?.[0];
      if (msg?.text === undefined) return null;
      return {
        text: msg.text,
        ...(msg.thread_ts !== undefined ? { threadTs: msg.thread_ts } : {}),
        ...(msg.user !== undefined ? { userId: msg.user } : {}),
      };
    } catch (err) {
      logger.warn({ err, channelId, ts }, "fetchMessage failed");
      return null;
    }
  };
  // workdirStorage 注入があれば archiveDir より優先する
  const workdirStorage =
    options.workdirStorage ?? createWorkdirStorage(options.archiveDir);

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

  const runner = new SessionRunner({
    configSource,
    store,
    router: new EgressRouter({ poster, formatter: toMrkdwn }),
    reactions,
    // mentionFormat は必須 (SessionRunner はプラットフォーム中立で既定値を
    // 持たない)。bridge.ts は Slack 専用モジュールなので、Slack の mrkdwn
    // mention 記法をここで注入する
    mentionFormat: (userId) => `<@${userId}>`,
    ...(options.piBinary !== undefined ? { piBinary: options.piBinary } : {}),
    ...(options.piEntrypoint !== undefined
      ? { piEntrypoint: options.piEntrypoint }
      : {}),
    ...(options.extraEnv !== undefined &&
    Object.keys(options.extraEnv).length > 0
      ? { extraEnv: options.extraEnv }
      : {}),
    // workdirStorage/archiveDir 未設定なら境界退避なし (Step 3 相当の挙動)
    workdirStorage,
    // agentUid/Gid 未設定なら UID 分離なし (現状動作)
    ...(options.agentUid !== undefined ? { agentUid: options.agentUid } : {}),
    ...(options.agentGid !== undefined ? { agentGid: options.agentGid } : {}),
    // agentHome 未設定なら SessionRunner の既定 (/home/agent) を使う
    ...(options.agentHome !== undefined
      ? { agentHome: options.agentHome }
      : {}),
    // piPermission 未設定なら Node Permission Model なし (現状動作)
    ...(options.piPermission !== undefined
      ? { piPermission: options.piPermission }
      : {}),
    // turnTimeoutMs 未設定なら SessionRunner の既定 (600_000ms) を使う
    ...(options.turnTimeoutMs !== undefined
      ? { turnTimeoutMs: options.turnTimeoutMs }
      : {}),
    // progressNoticeIntervalMs 未設定なら SessionRunner の既定 (30_000ms) を使う
    ...(options.progressNoticeIntervalMs !== undefined
      ? { progressNoticeIntervalMs: options.progressNoticeIntervalMs }
      : {}),
    // classifierClient 未構築なら classifier gate 非対応 (createGate が throw する)
    ...(classifierClient !== undefined ? { classifierClient } : {}),
  });

  // Layer 0 (ハードフィルタ): 同一メッセージは app_mention と message の 2 イベントで
  // 届く (event_id は別) ため、メッセージ ts で重複排除する。inbox の dedupe は
  // event_id ベースなので、この二重配信はここでしか防げない
  const seenMessages = new Set<string>();

  await eventSource.start(async (event: ChatEvent, ack: Ack) => {
    // 3 秒 ACK の意味は入口で違う (Socket Mode = ack コールバック, Events API = 200
    // レスポンス) が、Ack で吸収されているのでここでは「積む前に ack する」だけ書けばよい
    // (architecture.md §1)。以降の残処理は ack 後も継続する
    await ack();

    logger.debug(
      {
        kind: event.kind,
        eventId: "id" in event ? event.id : undefined,
        channelId: event.conversation?.channelId,
        isDm: event.conversation?.isDm,
        userId: "sender" in event ? event.sender.id : undefined,
      },
      "event received",
    );

    if (event.kind === "reaction") {
      if (event.sender.isBot) {
        logger.info(
          { reason: "bot_message", kind: event.kind },
          "event ignored",
        );
        return;
      }
      try {
        await runner.handleReaction(event, fetchMessage);
      } catch (err) {
        logger.error({ err }, "failed to handle reaction");
      }
      return;
    }

    if (event.kind !== "message") {
      logger.info(
        { reason: "unsupported_kind", kind: event.kind },
        "event ignored",
      );
      return;
    }

    const messageKey = `${event.conversation.channelId}:${event.id}`;
    if (seenMessages.has(messageKey)) {
      logger.info(
        { reason: "duplicate_delivery", eventId: event.id },
        "event ignored",
      );
      return;
    }
    seenMessages.add(messageKey);
    if (seenMessages.size > 1000) {
      seenMessages.clear();
    }

    if (event.sender.isBot) {
      logger.info(
        { reason: "bot_message", eventId: event.id },
        "event ignored",
      );
      return;
    }

    // enrichEvent は kind を変えないため、message であることは維持される
    const enriched = (await enrichEvent(event, resolver)) as InboundMessage;

    try {
      await runner.handle(enriched);
    } catch (err) {
      logger.error({ eventId: enriched.id, err }, "failed to handle event");
    }
  });

  logger.info({}, "ingress started; waiting for events");
}
