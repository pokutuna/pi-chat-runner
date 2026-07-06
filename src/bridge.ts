// startBridge — composition root (SessionRunner の組み立てと EventSource の配線)。
//
// server.ts (CLI/bin) と、npm パッケージとして import して起動するライブラリ利用
// (docs/design/config.md §6) の両方から呼ばれる共通の起動シーケンス。env パース・
// composition の分離については server.ts のコメントを参照。
//
// extensionPaths は options に出さない: reply tool と permission-gate の常時注入は
// 外せない安全方針 (docs/design/config.md §5「reply tool の注入・RPC 結線 | コード」)。
// この 2 extension は常にここで import.meta.url 相対に解決する。

import { fileURLToPath } from "node:url";
import type { WebClient } from "@slack/web-api";
import type { ChatEvent, InboundMessage } from "./ingress/chat-event.js";
import type { Ack, EventSource } from "./ingress/event-source.js";
import { enrichEvent, SlackUserResolver } from "./ingress/user-resolver.js";
import type { Logger } from "./logger.js";
import { rootLogger } from "./logger.js";
import { Reactions } from "./reply/reactions.js";
import { ReplyRouter } from "./reply/router.js";
import type { PiPermissionConfig } from "./session/runner.js";
import { SessionRunner } from "./session/runner.js";
import type { ConfigSource } from "./store/config-source.js";
import type { StateStore } from "./store/interfaces.js";
import { CopyWorkdirStorage } from "./store/workdir-storage.js";

export interface BridgeOptions {
	/** 受信の入口 (Socket Mode / Events API / 呼び出し側独自の実装)。ライブラリ利用の
	 * 本命 seam — 別の Slack app 実装から独自 EventSource を差し込める。 */
	eventSource: EventSource;
	/** 返信投稿 (chat.postMessage) と reaction (reactions.add) に使う。 */
	web: WebClient;
	store: StateStore;
	configSource: ConfigSource;
	model?: string;
	provider?: string;
	turnTimeoutMs?: number;
	extraEnv?: Record<string, string>;
	archiveDir?: string;
	agentUid?: number;
	agentGid?: number;
	agentHome?: string;
	piPermission?: PiPermissionConfig;
	logger?: Logger;
}

/** SessionRunner を組み立て、eventSource を起動して配線する。呼び出し元 (server.ts の
 * main、または import した Slack app 実装) が env パースを済ませた後に呼ぶ。 */
export async function startBridge(options: BridgeOptions): Promise<void> {
	const logger = options.logger ?? rootLogger.child({ component: "server" });
	const { web, eventSource, store, configSource } = options;

	// メッセージ描画時の UserID → 表示名解決 (renderEvent / mention 展開)
	const resolver = new SlackUserResolver({
		usersInfo: (userId) => web.users.info({ user: userId }),
	});

	const runner = new SessionRunner({
		configSource,
		store,
		router: new ReplyRouter({
			poster: {
				async postMessage(channelId, text, threadTs) {
					await web.chat.postMessage({
						channel: channelId,
						text,
						...(threadTs !== undefined ? { thread_ts: threadTs } : {}),
					});
				},
			},
		}),
		reactions: new Reactions({
			add: (args) => web.reactions.add(args),
		}),
		// tsx 実行時は <repo>/src/../extensions、build 後は <repo>/dist/../extensions を指す。
		// pi が --extension で TS ソースを直接ロードするためビルド対象外 (build-plan.md)。
		// permission-gate は事故防止層 (docs/research/pi-tools-and-sandbox.md) として
		// reply と同様に常時注入する
		extensionPaths: [
			fileURLToPath(new URL("../extensions/reply.ts", import.meta.url)),
			fileURLToPath(
				new URL("../extensions/permission-gate.ts", import.meta.url),
			),
		],
		...(options.model !== undefined ? { model: options.model } : {}),
		...(options.provider !== undefined ? { provider: options.provider } : {}),
		...(options.extraEnv !== undefined &&
		Object.keys(options.extraEnv).length > 0
			? { extraEnv: options.extraEnv }
			: {}),
		// archiveDir 未設定なら境界退避なし (Step 3 相当の挙動)
		...(options.archiveDir !== undefined && options.archiveDir !== ""
			? { workdirStorage: new CopyWorkdirStorage(options.archiveDir) }
			: {}),
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

	logger.info({}, "event source started; waiting for events");
}
