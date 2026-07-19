// LocalChat core の公開契約 (docs/design/local-dev.md §2)
//
// I/O を持たないプログラマブルなフェイクチャット。REPL アダプタ (repl.ts) と
// e2e テストの両方がこの契約に対して書かれる。実装は local-chat.ts。

import type { EventEmitter } from "node:events";

import type { Reactions } from "../../egress/reactions.js";
import type { ChatPoster } from "../../egress/router.js";
import type { FetchMessage } from "../../session/runner.js";
import type { Sender } from "../chat-event.js";
import type { Ingress } from "../ingress.js";
import type { UserResolver } from "../user-resolver.js";

/** ログに積まれる 1 メッセージ。人間入力 (post) と bot 投稿 (poster) の両方が
 * 同じログに通し番号で積まれる — bot 投稿への reaction 起動 (fetchMessage) や
 * スレッド返信を Slack と同じに動かすため (local-dev.md §2)。 */
export interface LoggedMessage {
  /** `[N]` 表示・参照用の連番 (1 始まり、人間/bot 通し)。 */
  seq: number;
  /** ログ連番 seq の文字列表現 ("1", "2", …)。表示の `[N]` と同一で、
   * sessionKey (`local:3`) との突合が容易。 */
  ts: string;
  channelId: string;
  threadTs?: string;
  isDm?: boolean;
  /** 本文。updateMessage (進捗通知の上書き) はこの場で書き換わる。 */
  text: string;
  sender: Sender;
  /** poster.postMessage の files (パスの記録のみ。アップロードはしない)。 */
  files?: string[];
  /** 人間 post 時の bot mention。表示で `@bot` を復元するための記録。 */
  mentionsBot?: boolean;
}

export interface PostOptions {
  /** 省略時は createLocalChat の defaultChannelId。 */
  channelId?: string;
  /** ログに存在しない ts も許す (local-dev.md §3: 未観測メッセージへの
   * スレッド返信の再現)。 */
  threadTs?: string;
  mentionsBot?: boolean;
  /** 省略時は { id: "U_LOCAL", isBot: false }。isSelf は常に false。 */
  sender?: { id: string; isBot?: boolean };
  isDm?: boolean;
}

export interface ReactOptions {
  channelId?: string;
  sender?: { id: string; isBot?: boolean };
  /** 省略時 true (reaction_added)。 */
  added?: boolean;
}

/** bot 側 (Reactions 経由) のリアクション記録。 */
export interface ReactionRecord {
  channelId: string;
  /** リアクション対象メッセージの ts。 */
  ts: string;
  emoji: string;
}

/** 変化通知。REPL は stdout 描画に、e2e は「返信が来るまで待つ」に使う。
 * message は人間入力 (post) を含む全ての新規ログ追加で発火する。 */
export interface LocalChatOutputEvents {
  message: [LoggedMessage];
  /** updateMessage による本文上書き (進捗通知)。 */
  update: [LoggedMessage];
  reaction: [ReactionRecord];
}

export interface LocalChatOptions {
  /** post/react の channelId 省略時の既定。既定 "local"。 */
  defaultChannelId?: string;
  /** bot 投稿の sender.id。既定 "U_BOT"。 */
  botUserId?: string;
}

export interface LocalChat {
  /** startBridge へ渡す注入物。全て同一のメッセージログを共有する。 */
  readonly ingress: Ingress;
  readonly poster: ChatPoster;
  readonly reactions: Reactions;
  readonly userResolver: UserResolver;
  readonly fetchMessage: FetchMessage;

  /** InboundMessage を合成して ingress の onEvent へ流し、ログに積む。
   * ingress.start() 前の呼び出しはバッファされ start 時に流れる。 */
  post(text: string, options?: PostOptions): Promise<LoggedMessage>;
  /** ReactionEvent を合成して onEvent へ流す。ts はログ上の実在チェックをしない。 */
  react(ts: string, emoji: string, options?: ReactOptions): Promise<void>;

  log(): readonly LoggedMessage[];
  bySeq(seq: number): LoggedMessage | undefined;
  /** bot が付けたリアクション (Reactions.add) の記録。 */
  reactionsLog(): readonly ReactionRecord[];

  readonly events: EventEmitter<LocalChatOutputEvents>;
}
