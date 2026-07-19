// LocalChat core の実装 (docs/design/local-dev.md §2)
//
// I/O を持たないプログラマブルなフェイクチャット。公開契約は ./types.ts に確定済み
// (このファイルはそれを実装するだけで、契約自体は変更しない)。
//
// 注入物 (ingress/poster/reactions/userResolver/fetchMessage) は全て同一の
// メッセージログを共有する — bot 投稿への reaction 起動 (fetchMessage) やスレッド
// 返信を Slack と同じに動かすため。bot 投稿はログに isSelf: true で記録するが、
// ChatEvent として onEvent へ還流はさせない (自己エコー経路を持たない)。

import { EventEmitter } from "node:events";

import { Reactions } from "../../egress/reactions.js";
import type { ChatPoster } from "../../egress/router.js";
import type { FetchedMessage, FetchMessage } from "../../session/runner.js";
import type { ChatEvent, InboundMessage, Sender } from "../chat-event.js";
import type { Ack, Ingress } from "../ingress.js";
import type { UserResolver } from "../user-resolver.js";
import type {
  LocalChat,
  LocalChatOptions,
  LocalChatOutputEvents,
  LoggedMessage,
  PostOptions,
  ReactionRecord,
  ReactOptions,
} from "./types.js";

const DEFAULT_CHANNEL_ID = "local";
const DEFAULT_BOT_USER_ID = "U_BOT";
const DEFAULT_SENDER_ID = "U_LOCAL";

export function createLocalChat(options?: LocalChatOptions): LocalChat {
  const defaultChannelId = options?.defaultChannelId ?? DEFAULT_CHANNEL_ID;
  const botUserId = options?.botUserId ?? DEFAULT_BOT_USER_ID;
  // userResolver と同じ固定マップを共有する (displayName 埋め込みで二重定義しない)。
  const displayNames: Record<string, string> = {
    U_LOCAL: "you",
    [botUserId]: "bot",
  };

  const log: LoggedMessage[] = [];
  const reactionsLog: ReactionRecord[] = [];
  const events = new EventEmitter<LocalChatOutputEvents>();

  let onEvent: ((e: ChatEvent, ack: Ack) => Promise<void>) | undefined;
  // start() 前に post/react された ChatEvent はここに溜め、start 時に順に流す。
  const pendingEvents: ChatEvent[] = [];

  const noopAck: Ack = () => Promise.resolve();

  async function emitToIngress(event: ChatEvent): Promise<void> {
    if (onEvent === undefined) {
      pendingEvents.push(event);
      return;
    }
    await onEvent(event, noopAck);
  }

  function findByTs(ts: string): LoggedMessage | undefined {
    return log.find((m) => m.ts === ts);
  }

  const ingress: Ingress = {
    start(handler) {
      onEvent = handler;
      const buffered = pendingEvents.splice(0, pendingEvents.length);
      return (async () => {
        for (const event of buffered) {
          await onEvent?.(event, noopAck);
        }
      })();
    },
    stop() {
      onEvent = undefined;
      return Promise.resolve();
    },
  };

  const poster: ChatPoster = {
    async postMessage(channelId, text, threadTs, files) {
      const seq = log.length + 1;
      const ts = String(seq);
      const message: LoggedMessage = {
        seq,
        ts,
        channelId,
        ...(threadTs !== undefined ? { threadTs } : {}),
        text,
        sender: {
          id: botUserId,
          isBot: true,
          isSelf: true,
          ...(displayNames[botUserId] !== undefined
            ? { displayName: displayNames[botUserId] }
            : {}),
        },
        ...(files !== undefined ? { files } : {}),
      };
      log.push(message);
      events.emit("message", message);
      return { messageId: ts };
    },
    updateMessage(_channelId, messageId, text) {
      const message = findByTs(messageId);
      if (message === undefined) return Promise.resolve();
      message.text = text;
      events.emit("update", message);
      return Promise.resolve();
    },
  };

  const reactions = new Reactions({
    add(args: { channel: string; timestamp: string; name: string }) {
      const record: ReactionRecord = {
        channelId: args.channel,
        ts: args.timestamp,
        emoji: args.name,
      };
      reactionsLog.push(record);
      events.emit("reaction", record);
      return Promise.resolve();
    },
  });

  const userResolver: UserResolver = {
    resolve(userId: string): Promise<string | null> {
      return Promise.resolve(displayNames[userId] ?? null);
    },
  };

  const fetchMessage: FetchMessage = (
    _channelId: string,
    ts: string,
  ): Promise<FetchedMessage | null> => {
    const message = findByTs(ts);
    if (message === undefined) return Promise.resolve(null);
    return Promise.resolve({
      text: message.text,
      ...(message.threadTs !== undefined ? { threadTs: message.threadTs } : {}),
      ...(message.sender.id !== undefined ? { userId: message.sender.id } : {}),
    });
  };

  async function post(
    text: string,
    postOptions?: PostOptions,
  ): Promise<LoggedMessage> {
    const channelId = postOptions?.channelId ?? defaultChannelId;
    const seq = log.length + 1;
    const ts = String(seq);
    const senderId = postOptions?.sender?.id ?? DEFAULT_SENDER_ID;
    const senderDisplayName = displayNames[senderId];
    const sender: Sender = {
      id: senderId,
      isBot: postOptions?.sender?.isBot ?? false,
      isSelf: false,
      ...(senderDisplayName !== undefined
        ? { displayName: senderDisplayName }
        : {}),
    };
    const message: LoggedMessage = {
      seq,
      ts,
      channelId,
      ...(postOptions?.threadTs !== undefined
        ? { threadTs: postOptions.threadTs }
        : {}),
      ...(postOptions?.isDm !== undefined ? { isDm: postOptions.isDm } : {}),
      text,
      sender,
      ...(postOptions?.mentionsBot === true ? { mentionsBot: true } : {}),
    };
    log.push(message);
    events.emit("message", message);

    const inbound: InboundMessage = {
      kind: "message",
      id: ts,
      conversation: {
        channelId,
        ...(postOptions?.threadTs !== undefined
          ? { threadTs: postOptions.threadTs }
          : {}),
        ...(postOptions?.isDm !== undefined ? { isDm: postOptions.isDm } : {}),
      },
      sender,
      text,
      mentionsBot: postOptions?.mentionsBot ?? false,
      attachments: [],
      timestamp: new Date(),
      metadata: {},
    };
    await emitToIngress(inbound);

    return message;
  }

  async function react(
    ts: string,
    emoji: string,
    reactOptions?: ReactOptions,
  ): Promise<void> {
    const channelId = reactOptions?.channelId ?? defaultChannelId;
    const target = findByTs(ts);
    const targetIsOwnMessage = target?.sender.isSelf ?? false;
    const sender: Sender = {
      id: reactOptions?.sender?.id ?? DEFAULT_SENDER_ID,
      isBot: reactOptions?.sender?.isBot ?? false,
      isSelf: false,
    };

    const reactionEvent: ChatEvent = {
      kind: "reaction",
      emoji,
      targetMessageId: ts,
      targetIsOwnMessage,
      conversation: { channelId },
      sender,
      added: reactOptions?.added ?? true,
      timestamp: new Date(),
    };
    await emitToIngress(reactionEvent);
  }

  return {
    ingress,
    poster,
    reactions,
    userResolver,
    fetchMessage,
    post,
    react,
    log(): readonly LoggedMessage[] {
      return log;
    },
    bySeq(seq: number): LoggedMessage | undefined {
      return log.find((m) => m.seq === seq);
    },
    reactionsLog(): readonly ReactionRecord[] {
      return reactionsLog;
    },
    events,
  };
}
