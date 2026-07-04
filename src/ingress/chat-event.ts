// ChatEvent 型定義 (docs/design/chat-model.md §2.3)
//
// 汎用モデルの ConversationRef / UserRef は docs/design/architecture.md §0 の
// 簡素化方針 (単一組織・Slack のみ) に従い、ここでは以下に潰す:
//   - ConversationRef -> ConversationRef { channelId, threadTs? }
//   - UserRef          -> Sender { id, isBot, displayName? }

/** 会話 (返信先) の参照。Slack: (channelId, threadTs) の 2 つだけ。 */
export interface ConversationRef {
	channelId: string;
	threadTs?: string;
}

/** 発言者。簡素版のため scope/platform は持たない。 */
export interface Sender {
	id: string;
	isBot: boolean;
	displayName?: string;
}

/** hermes と同じ平坦化 5 フィールド (chat-model.md §2.3) */
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
}

/** 編集イベント。Step 1 では最小のスタブ型。 */
export interface MessageEdited {
	kind: "message_edited";
	id: string;
	conversation: ConversationRef;
	raw?: unknown;
}

/** channel_joined など。当面はログのみ (chat-model.md §2.3)。Step 1 では最小のスタブ型。 */
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
