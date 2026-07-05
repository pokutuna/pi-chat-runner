// InMemory 実装 (docs/design/persistence.md §1 の InboxStore/SessionStore/LeaseStore)
//
// Map ベース。プロセス再起動で消えるが、ローカルお試し・単体テストの既定として使う。
// lease の期限判定は Date.now() を既定とし、テストで時間を進められるよう
// `now` をコンストラクタで注入可能にする。

import type {
	InboxItem,
	InboxStore,
	Lease,
	LeaseStore,
	SessionDoc,
	SessionStore,
	StateStore,
} from "./interfaces.js";

class InMemoryInboxStore implements InboxStore {
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
		if (queue === undefined) return [];
		return [...queue];
	}

	async ack(threadKey: string, itemIds: string[]): Promise<void> {
		const queue = this.queues.get(threadKey);
		if (queue === undefined) return;
		const acked = new Set(itemIds);
		this.queues.set(
			threadKey,
			queue.filter((item) => !acked.has(item.id)),
		);
	}
}

class InMemorySessionStore implements SessionStore {
	private readonly docs = new Map<string, SessionDoc>();

	async get(threadKey: string): Promise<SessionDoc | null> {
		const doc = this.docs.get(threadKey);
		return doc === undefined ? null : { ...doc };
	}

	async put(threadKey: string, doc: SessionDoc): Promise<void> {
		this.docs.set(threadKey, { ...doc });
	}
}

class InMemoryLeaseStore implements LeaseStore {
	private readonly leases = new Map<string, Lease>();

	constructor(private readonly now: () => number) {}

	async acquire(
		threadKey: string,
		owner: string,
		ttlMs: number,
	): Promise<Lease | null> {
		const current = this.leases.get(threadKey);
		const isExpired =
			current !== undefined && current.expiresAt.getTime() <= this.now();
		if (current !== undefined && !isExpired) return null;

		const token = current === undefined ? 0 : current.token + 1;
		const lease: Lease = {
			threadKey,
			owner,
			token,
			expiresAt: new Date(this.now() + ttlMs),
		};
		this.leases.set(threadKey, lease);
		return { ...lease };
	}

	async renew(lease: Lease, ttlMs: number): Promise<boolean> {
		const current = this.leases.get(lease.threadKey);
		if (current === undefined) return false;
		if (current.token !== lease.token || current.owner !== lease.owner) {
			return false;
		}
		if (current.expiresAt.getTime() <= this.now()) return false;

		this.leases.set(lease.threadKey, {
			...current,
			expiresAt: new Date(this.now() + ttlMs),
		});
		return true;
	}

	async release(lease: Lease): Promise<void> {
		const current = this.leases.get(lease.threadKey);
		if (current === undefined) return;
		if (current.token !== lease.token) return;
		this.leases.delete(lease.threadKey);
	}
}

export class InMemoryStateStore implements StateStore {
	readonly inbox: InboxStore = new InMemoryInboxStore();
	readonly sessions: SessionStore = new InMemorySessionStore();
	readonly leases: LeaseStore;

	constructor(now: () => number = Date.now) {
		this.leases = new InMemoryLeaseStore(now);
	}
}
