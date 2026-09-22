// Slack の ChatPlatform 実装 — docs/design/architecture.md §4,
// docs/design/ingress-egress.md §2, §5, §6, §7
//
// Slack Web API の呼び出しをここに集める組み立て点。@slack/web-api に触るのは
// このファイルと src/ingress/slack/ だけで、Runner (src/runner.ts) 以降には
// WebClient も Slack のデータ構造も渡らない。
//
// transport (HttpIngress / SocketIngress) の選択は System Config の話なので
// 呼び出し元 (src/server.ts) が済ませ、ここには出来上がった Ingress を渡す。

import { basename } from "node:path";

import { WebClient } from "@slack/web-api";

import {
  EmojiTurnReactor,
  type StateEmojiMap,
} from "../egress/emoji-turn-reactor.js";
import { toMrkdwn } from "../egress/mrkdwn.js";
import type { ChatPoster } from "../egress/router.js";
import type { FetchMessage } from "../gate/evaluate.js";
import type { Ingress } from "../ingress/ingress.js";
import { SlackUserResolver } from "../ingress/slack/user-resolver.js";
import type { Logger } from "../logger.js";
import { rootLogger } from "../logger.js";
import type { ChatPlatform } from "./platform.js";

/** Turn 状態 (start/ok/error) に対応する Slack の絵文字名
 * (ingress-egress.md §7)。 */
export const SLACK_STATE_EMOJI: StateEmojiMap = {
  start: "eyes",
  ok: "white_check_mark",
  error: "x",
};

export interface SlackPlatformOptions {
  /** Slack Web API client。poster / reactor / userResolver / fetchMessage の実体。 */
  web: WebClient;
  /** 受信の入口 (SocketIngress / HttpIngress / 呼び出し側独自の実装)。 */
  ingress: Ingress;
  /** fetchMessage の失敗を記録するロガー。省略時は component: "chat" の子ロガー。 */
  logger?: Logger;
}

/** botToken から WebClient を作る。Slack の client を構築するのはこのモジュールだけ
 * なので、呼び出し元 (server.ts) は token を渡すだけでよい。 */
export function createSlackWebClient(botToken: string): WebClient {
  return new WebClient(botToken);
}

/** Slack 向けの ChatPlatform を組み立てる。 */
export function createSlackPlatform(
  options: SlackPlatformOptions,
): ChatPlatform {
  const { web, ingress } = options;
  const logger = options.logger ?? rootLogger.child({ component: "chat" });

  // files 指定時は files.uploadV2 (initial_comment に text を乗せる)、無指定時は
  // chat.postMessage。messageId (Slack の ts) は進捗通知 (ingress-egress.md §8) の
  // updateMessage が使う — files.uploadV2 は投稿本体のメッセージ ts を返さないため、
  // その場合は messageId 抽象を持たない (updateMessage の対象にはならない。進捗通知は
  // files を使わないので実害はない)
  const poster: ChatPoster = {
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

  // reaction トリガーの対象メッセージ本文取得 (config.md §4.1 の `kind: reaction`)。
  // conversations.replies は ts が親でもスレッド返信でも、その ts のメッセージ自身を
  // 先頭で返す
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

  return {
    ingress,
    poster,
    reactor: new EmojiTurnReactor(
      { add: (args) => web.reactions.add(args) },
      SLACK_STATE_EMOJI,
    ),
    userResolver: new SlackUserResolver({
      usersInfo: (userId) => web.users.info({ user: userId }),
    }),
    fetchMessage,
    mentionFormat: (userId) => `<@${userId}>`,
    formatter: toMrkdwn,
  };
}
