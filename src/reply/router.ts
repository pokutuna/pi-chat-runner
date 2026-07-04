// ReplyRouter — thread_key → 投稿先の解決と postMessage
//
// エージェントの確定出力は reply(thread_key, text) ツール経由の 1 本のみで、
// ホストが tool_execution_end を拾ってここへ流す (docs/design/architecture.md §6 フロー 5、
// docs/design/chat-model.md §5)。formatter フックは mrkdwn 変換等の将来差し込み点で、
// Step 3 では identity。

import type { Logger } from "../logger.js";
import { rootLogger } from "../logger.js";
import type { ReplyPayload } from "../session/rpc.js";

/** 投稿先。Slack の会話座標は (channelId, threadTs) の 2 つだけ (architecture.md §0) */
export interface ReplyDestination {
	channelId: string;
	threadTs: string;
}

/** WebClient.chat.postMessage の薄い IF。テストではフェイクを注入する */
export interface ChatPoster {
	postMessage(channelId: string, threadTs: string, text: string): Promise<void>;
}

export type ReplyFormatter = (text: string) => string;

export interface ReplyRouterOptions {
	poster: ChatPoster;
	/** 投稿前にテキストを通すフック。省略時は identity */
	formatter?: ReplyFormatter;
	logger?: Logger;
}

export class ReplyRouter {
	private readonly destinations = new Map<string, ReplyDestination>();
	private readonly poster: ChatPoster;
	private readonly formatter: ReplyFormatter;
	private readonly logger: Logger;

	constructor(options: ReplyRouterOptions) {
		this.poster = options.poster;
		this.formatter = options.formatter ?? ((text) => text);
		this.logger = options.logger ?? rootLogger.child({ component: "reply" });
	}

	register(threadKey: string, destination: ReplyDestination): void {
		this.destinations.set(threadKey, destination);
	}

	/** 未知の thread_key は warn して捨てる (エージェントの引数間違いでホストを落とさない) */
	async deliver(payload: ReplyPayload): Promise<void> {
		const destination = this.destinations.get(payload.thread_key);
		if (destination === undefined) {
			this.logger.warn(
				{ threadKey: payload.thread_key },
				"unknown thread_key; dropping reply",
			);
			return;
		}
		try {
			await this.poster.postMessage(
				destination.channelId,
				destination.threadTs,
				this.formatter(payload.text),
			);
			this.logger.info(
				{ threadKey: payload.thread_key, textLength: payload.text.length },
				"reply delivered",
			);
		} catch (err) {
			this.logger.error(
				{ threadKey: payload.thread_key, err },
				"reply post failed",
			);
			throw err;
		}
	}
}
