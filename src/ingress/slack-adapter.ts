// SlackIngressAdapter (codec) — docs/design/chat-model.md §3.2
//
// 「届いた生 payload を ChatEvent に正規化する」変換器。transport (Socket Mode /
// Events API) には依存しない純関数的な codec。EventSource 実装がこれを内部で使う。
//
// HTTP 署名検証 (IngressAdapter.verify) は Step 5 (Events API) で実装する。
// Step 1 (Socket Mode) では署名検証の対象となる HTTP リクエストが存在しないため未実装。

import type {
	ChatEvent,
	ConversationRef,
	InboundMessage,
	ReactionEvent,
} from "./chat-event.js";

/** Slack Events API の envelope: `{ event_id, event: {...}, ... }` (簡略化した最小の型) */
export interface SlackEventEnvelope {
	event_id?: string;
	event: SlackRawEvent;
	[key: string]: unknown;
}

/** Step 1 で扱う Slack raw event の和 (app_mention / message / reaction_added)。
 * Slack の公式型パッケージ (@slack/types) は依存に無いため、必要フィールドのみ最小定義する。 */
export type SlackRawEvent =
	| SlackMessageLikeEvent
	| SlackReactionAddedEvent
	| { type: string; [key: string]: unknown };

export interface SlackMessageLikeEvent {
	type: "app_mention" | "message";
	subtype?: string;
	text?: string;
	user?: string;
	bot_id?: string;
	channel: string;
	/** "im" が DM。省略される場合があるので channelId の "D" prefix で fallback する */
	channel_type?: string;
	ts: string;
	thread_ts?: string;
	[key: string]: unknown;
}

export interface SlackReactionAddedEvent {
	type: "reaction_added" | "reaction_removed";
	user: string;
	reaction: string;
	item: { type: "message"; channel: string; ts: string };
	[key: string]: unknown;
}

const MENTION_PATTERN = /<@([A-Z0-9]+)>/g;

/** mention 展開: `<@U123>` を除去した本文と、bot 自身への mention があったかを返す。 */
function stripMentions(
	text: string,
	botUserId: string,
): { text: string; mentionsBot: boolean } {
	let mentionsBot = false;
	const stripped = text
		.replace(MENTION_PATTERN, (_full, userId: string) => {
			if (userId === botUserId) {
				mentionsBot = true;
				return "";
			}
			return `@${userId}`;
		})
		.trim();
	return { text: stripped, mentionsBot };
}

/** SlackIngressAdapter: Slack raw event -> ChatEvent の正規化を担う codec。
 * transport 非依存 (Socket Mode / Events API の両方から使う想定, chat-model.md §3.2)。 */
export class SlackIngressAdapter {
	constructor(private readonly botUserId: string) {}

	/** raw event payload -> ChatEvent。対象外の type は null を返す。 */
	normalize(rawEvent: SlackRawEvent, eventId?: string): ChatEvent | null {
		switch (rawEvent.type) {
			case "app_mention":
			case "message":
				return this.normalizeMessage(
					rawEvent as SlackMessageLikeEvent,
					eventId,
				);
			case "reaction_added":
			case "reaction_removed":
				return this.normalizeReaction(rawEvent as SlackReactionAddedEvent);
			default:
				return null;
		}
	}

	private normalizeMessage(
		event: SlackMessageLikeEvent,
		eventId?: string,
	): InboundMessage | null {
		// message_changed / message_deleted 等の subtype は Step 1 では扱わない
		if (event.subtype !== undefined) {
			return null;
		}

		const rawText = event.text ?? "";
		const { text, mentionsBot: strippedMention } = stripMentions(
			rawText,
			this.botUserId,
		);
		// app_mention は Slack が既に「bot への mention」と確定済みのイベント種別なので常に true。
		// message イベントは本文中の <@bot> の有無で判定する。
		const mentionsBot = event.type === "app_mention" ? true : strippedMention;

		const isBot = event.bot_id !== undefined || event.user === this.botUserId;

		// channel_type が無い場合 (一部の payload では省略される) は channelId の "D" prefix で
		// フォールバック判定する (Slack の DM channelId は D で始まる)。
		const isDm =
			event.channel_type !== undefined
				? event.channel_type === "im"
				: event.channel.startsWith("D");

		const conversation: ConversationRef = {
			channelId: event.channel,
			...(event.thread_ts !== undefined ? { threadTs: event.thread_ts } : {}),
			...(isDm ? { isDm: true } : {}),
		};

		return {
			kind: "message",
			id: event.ts,
			conversation,
			sender: {
				id: event.user ?? event.bot_id ?? "unknown",
				isBot,
			},
			text,
			mentionsBot,
			attachments: [],
			timestamp: slackTsToDate(event.ts),
			raw: event,
			metadata: eventId !== undefined ? { eventId } : {},
		};
	}

	private normalizeReaction(event: SlackReactionAddedEvent): ReactionEvent {
		return {
			kind: "reaction",
			emoji: event.reaction,
			targetMessageId: event.item.ts,
			targetIsOwnMessage: false, // 判定には対象メッセージの発言者情報が必要 (Step 1 では未解決)
			conversation: { channelId: event.item.channel },
			sender: { id: event.user, isBot: false },
			added: event.type === "reaction_added",
			timestamp: new Date(),
		};
	}

	/** 再配送 dedupe 用のイベント ID。Slack の event_id を返す (chat-model.md §3.2)。 */
	dedupeKey(envelope: SlackEventEnvelope): string | undefined {
		return envelope.event_id;
	}
}

function slackTsToDate(ts: string): Date {
	const seconds = Number.parseFloat(ts);
	return new Date(seconds * 1000);
}
