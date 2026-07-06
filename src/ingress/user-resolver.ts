// UserResolver — Slack userId から表示名への解決 (bridge 層で ChatEvent を enrich するための seam)
//
// Sender.displayName (chat-event.ts) を埋めるためのインターフェース。実装は Slack
// users.info を叩く SlackUserResolver で、WebClient には直接依存せず最小 IF を
// 受け取る (テストでフェイク注入しやすくするため)。

import type { ChatEvent, Sender } from "./chat-event.js";

/** userId → 表示名の解決。bridge が Slack users.info で実装し、失敗時は null */
export interface UserResolver {
	resolve(userId: string): Promise<string | null>;
}

/** users.info が返す最小の形。WebClient の型に直接依存しないための最小 IF */
export interface UsersInfoClient {
	usersInfo(userId: string): Promise<{
		user?: {
			profile?: { display_name?: string };
			real_name?: string;
			name?: string;
		};
	}>;
}

/** Slack users.info を使った UserResolver 実装。
 * 解決順: profile.display_name (空文字は無視) -> real_name -> name -> null。
 * 結果は Map に無期限キャッシュする (失敗時の null も含む)。 */
export class SlackUserResolver implements UserResolver {
	private readonly cache = new Map<string, string | null>();

	constructor(private readonly client: UsersInfoClient) {}

	async resolve(userId: string): Promise<string | null> {
		const cached = this.cache.get(userId);
		if (cached !== undefined) return cached;

		let resolved: string | null;
		try {
			const { user } = await this.client.usersInfo(userId);
			const displayName = user?.profile?.display_name;
			resolved =
				(displayName !== undefined && displayName !== ""
					? displayName
					: undefined) ??
				user?.real_name ??
				user?.name ??
				null;
		} catch {
			resolved = null;
		}
		this.cache.set(userId, resolved);
		return resolved;
	}
}

/** slack-adapter.ts の stripMentions が生成する `@U123ABC` 形式の mention パターン */
const STRIPPED_MENTION_PATTERN = /@(U[A-Z0-9]+)/g;

/** ChatEvent の sender.id / text 中の mention を表示名に解決した新しい ChatEvent を返す。
 * kind !== "message" はそのまま (何もせず) 返す。解決できなかった ID は変更しない。 */
export async function enrichEvent(
	event: ChatEvent,
	resolver: UserResolver,
): Promise<ChatEvent> {
	if (event.kind !== "message") return event;

	const senderName = await resolver.resolve(event.sender.id);
	const sender: Sender =
		senderName !== null
			? { ...event.sender, displayName: senderName }
			: event.sender;

	const matches = [...event.text.matchAll(STRIPPED_MENTION_PATTERN)];
	let text = event.text;
	if (matches.length > 0) {
		const uniqueIds = [
			...new Set(
				matches.map((m) => m[1]).filter((id): id is string => id !== undefined),
			),
		];
		const resolvedNames = new Map<string, string>();
		for (const userId of uniqueIds) {
			const name = await resolver.resolve(userId);
			if (name !== null) resolvedNames.set(userId, name);
		}
		text = event.text.replace(
			STRIPPED_MENTION_PATTERN,
			(full, userId: string) => {
				const name = resolvedNames.get(userId);
				return name !== undefined ? `@${name}` : full;
			},
		);
	}

	return { ...event, sender, text };
}
