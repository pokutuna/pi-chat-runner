// ChatEvent 型定義 (docs/design/ingress-egress.md §1)
//
// 汎用モデルの ConversationRef / UserRef は docs/design/ingress-egress.md §1 の
// 簡素化方針 (単一組織・Slack のみ) に従い、ここでは以下に潰す:
//   - ConversationRef -> ConversationRef { channelId, threadTs? }
//   - UserRef          -> Sender { id, isBot, isSelf, displayName? }

/** 会話 (返信先) の参照。Slack: (channelId, threadTs) の 2 つだけ。 */
export interface ConversationRef {
  channelId: string;
  threadTs?: string;
  /** Slack の im (DM)。DM は ChannelConfig の予約名 dm と既定 passthrough gate の対象になる
   * (docs/design/config.md §3.1)。 */
  isDm?: boolean;
}

/** 発言者。簡素版のため scope/platform は持たない。 */
export interface Sender {
  id: string;
  /** bot による投稿 (自分自身を含む)。 */
  isBot: boolean;
  /** 自分自身 (この bot) の投稿。エコーの無限ループ防止のため Ingress ステージ
   * (src/ingress/pipeline.ts) が設定に関わらず常に除外する。 */
  isSelf: boolean;
  /** 表示名。Ingress ステージで解決できた場合のみ入る。無ければ id を使う。
   * sender gate の name 判定 (config.md §4.2) はこの値との完全一致で行うため、
   * Ingress ステージは message/reaction を gate 評価に渡す前に enrichEvent で解決する。 */
  displayName?: string;
}

/** hermes と同じ平坦化 5 フィールド (ingress-egress.md §1) */
export interface ReplyContext {
  messageId: string;
  excerpt: string;
  authorId?: string;
  authorName?: string;
  isReplyToSelf: boolean;
}

/** 添付ファイル。Step 1 では型のみで処理は未実装。 */
export interface Attachment {
  kind: "image" | "audio" | "video" | "document" | "text";
  name: string;
  mimeType: string;
  sizeBytes: number;
  storageUri: string;
}

export interface InboundMessage {
  kind: "message";
  id: string;
  conversation: ConversationRef;
  sender: Sender;
  text: string;
  mentionsBot: boolean;
  reply?: ReplyContext;
  attachments: Attachment[];
  editedFrom?: string;
  timestamp: Date;
  raw?: unknown;
  metadata: Record<string, unknown>;
}

export interface ReactionEvent {
  kind: "reaction";
  emoji: string;
  targetMessageId: string;
  targetIsOwnMessage: boolean;
  conversation: ConversationRef;
  sender: Sender;
  added: boolean;
  timestamp: Date;
  raw?: unknown;
}

/** 編集イベント。Step 1 では最小のスタブ型。 */
export interface MessageEdited {
  kind: "message_edited";
  id: string;
  conversation: ConversationRef;
  raw?: unknown;
}

/** channel_joined など。当面はログのみ (ingress-egress.md §1)。Step 1 では最小のスタブ型。 */
export interface SystemEvent {
  kind: "system";
  subtype: string;
  conversation?: ConversationRef;
  raw?: unknown;
}

export type ChatEvent =
  | InboundMessage
  | ReactionEvent
  | MessageEdited
  | SystemEvent;
