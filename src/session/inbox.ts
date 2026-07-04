// InboxStore — セッション入力の耐久キュー (Step 3 はインメモリ実装)
//
// docs/design/architecture.md §1 の「event は積むだけ、session が drain して処理する」
// 境界をここで表現する。Step 4 で Firestore 実装 (doc ID = event_id の create() による
// dedupe) に置き換わるため、IF は enqueue/drain の 2 メソッドだけに薄く保つ。

import type { InboundMessage } from "../ingress/chat-event.js";

export interface InboxItem {
	/** dedupe キー。Slack event_id (metadata.eventId)、無ければ message ts (event.id) */
	id: string;
	event: InboundMessage;
	enqueuedAt: Date;
}

export interface InboxStore {
	/** 積めたら true。同 id が既に積まれた (または処理済みの) 場合は積まず false */
	enqueue(threadKey: string, item: InboxItem): Promise<boolean>;
	/** 未処理分を取り出す (取り出したら空になる)。enqueue 順を保つ */
	drain(threadKey: string): Promise<InboxItem[]>;
}

/** InboxItem.id の導出。Slack リトライは同じ event_id で届くため、これで冪等排除できる
 * (app_mention/message の二重配信は別 event_id なので、ここではなく server 側で防ぐ)。 */
export function inboxItemId(event: InboundMessage): string {
	const eventId = event.metadata.eventId;
	return typeof eventId === "string" ? eventId : event.id;
}

/** Step 3 のインメモリ実装。dedupe は drain 後も効かせる (Firestore 実装では
 * 「処理済み doc は flush まで残る」ことで同等の窓が得られる。§2 の create() 排除)。 */
export class InMemoryInbox implements InboxStore {
	private readonly queues = new Map<string, InboxItem[]>();
	private readonly seen = new Map<string, Set<string>>();

	async enqueue(threadKey: string, item: InboxItem): Promise<boolean> {
		let seen = this.seen.get(threadKey);
		if (seen === undefined) {
			seen = new Set();
			this.seen.set(threadKey, seen);
		}
		if (seen.has(item.id)) return false;
		seen.add(item.id);

		let queue = this.queues.get(threadKey);
		if (queue === undefined) {
			queue = [];
			this.queues.set(threadKey, queue);
		}
		queue.push(item);
		return true;
	}

	async drain(threadKey: string): Promise<InboxItem[]> {
		const queue = this.queues.get(threadKey);
		if (queue === undefined || queue.length === 0) return [];
		this.queues.set(threadKey, []);
		return queue;
	}
}
