// InMemory 実装 (docs/design/state.md §4)
//
// Map ベース。プロセス再起動で消えるが、ローカルお試し・単体テストの既定として使う。
// lease の期限判定は Date.now() を既定とし、テストで時間を進められるよう
// `now` をコンストラクタで注入可能にする。

import type {
  ChannelLatestSession,
  ChannelStateDoc,
  ChannelStateStore,
  ControlState,
  InboxItem,
  InboxStore,
  Lease,
  LeaseStore,
  SessionRecord,
  SessionStore,
  ThreadStore,
} from "../interfaces.js";

class InMemoryInboxStore implements InboxStore {
  private readonly queues = new Map<string, InboxItem[]>();
  private readonly seen = new Map<string, Set<string>>();

  async enqueue(sessionKey: string, item: InboxItem): Promise<boolean> {
    let seen = this.seen.get(sessionKey);
    if (seen === undefined) {
      seen = new Set();
      this.seen.set(sessionKey, seen);
    }
    if (seen.has(item.id)) return false;
    seen.add(item.id);

    let queue = this.queues.get(sessionKey);
    if (queue === undefined) {
      queue = [];
      this.queues.set(sessionKey, queue);
    }
    queue.push(item);
    return true;
  }

  async drain(sessionKey: string): Promise<InboxItem[]> {
    const queue = this.queues.get(sessionKey);
    if (queue === undefined) return [];
    return [...queue];
  }

  async ack(sessionKey: string, itemIds: string[]): Promise<void> {
    const queue = this.queues.get(sessionKey);
    if (queue === undefined) return;
    const acked = new Set(itemIds);
    this.queues.set(
      sessionKey,
      queue.filter((item) => !acked.has(item.id)),
    );
  }
}

class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();

  async get(sessionKey: string): Promise<SessionRecord | null> {
    const record = this.records.get(sessionKey);
    return record === undefined ? null : { ...record };
  }

  async put(sessionKey: string, record: SessionRecord): Promise<void> {
    this.records.set(sessionKey, { ...record });
  }
}

class InMemoryThreadStore implements ThreadStore {
  private readonly bindings = new Map<string, string>();
  private readonly latestByChannel = new Map<string, ChannelLatestSession>();

  constructor(private readonly now: () => number) {}

  async resolve(derivedSessionKey: string): Promise<string | null> {
    return this.bindings.get(derivedSessionKey) ?? null;
  }

  async bind(derivedSessionKey: string, sessionKey: string): Promise<void> {
    this.bindings.set(derivedSessionKey, sessionKey);
  }

  async latest(channelId: string): Promise<ChannelLatestSession | null> {
    const latest = this.latestByChannel.get(channelId);
    return latest === undefined ? null : { ...latest };
  }

  async touchLatest(channelId: string, sessionKey: string): Promise<void> {
    this.latestByChannel.set(channelId, {
      sessionKey,
      lastActiveAt: new Date(this.now()),
    });
  }

  async markLatestEnded(channelId: string, sessionKey: string): Promise<void> {
    const current = this.latestByChannel.get(channelId);
    if (current === undefined || current.sessionKey !== sessionKey) return;
    const endedAt = new Date(this.now());
    this.latestByChannel.set(channelId, {
      sessionKey,
      lastActiveAt: endedAt,
      endedAt,
    });
  }
}

class InMemoryLeaseStore implements LeaseStore {
  private readonly leases = new Map<string, Lease>();

  constructor(private readonly now: () => number) {}

  async acquire(
    sessionKey: string,
    owner: string,
    ttlMs: number,
  ): Promise<Lease | null> {
    const current = this.leases.get(sessionKey);
    const isExpired =
      current !== undefined && current.expiresAt.getTime() <= this.now();
    if (current !== undefined && !isExpired) return null;

    const token = current === undefined ? 0 : current.token + 1;
    const lease: Lease = {
      sessionKey,
      owner,
      token,
      expiresAt: new Date(this.now() + ttlMs),
    };
    this.leases.set(sessionKey, lease);
    return { ...lease };
  }

  async renew(lease: Lease, ttlMs: number): Promise<boolean> {
    const current = this.leases.get(lease.sessionKey);
    if (current === undefined) return false;
    if (current.token !== lease.token || current.owner !== lease.owner) {
      return false;
    }
    if (current.expiresAt.getTime() <= this.now()) return false;

    this.leases.set(lease.sessionKey, {
      ...current,
      expiresAt: new Date(this.now() + ttlMs),
    });
    return true;
  }

  async release(lease: Lease): Promise<void> {
    const current = this.leases.get(lease.sessionKey);
    if (current === undefined) return;
    if (current.token !== lease.token) return;
    this.leases.delete(lease.sessionKey);
  }
}

class InMemoryChannelStateStore implements ChannelStateStore {
  private readonly docs = new Map<string, ChannelStateDoc>();

  async get(channelId: string): Promise<ChannelStateDoc | null> {
    const doc = this.docs.get(channelId);
    return doc === undefined ? null : { ...doc };
  }

  async put(channelId: string, doc: ChannelStateDoc): Promise<void> {
    this.docs.set(channelId, {
      enabled: doc.enabled,
      updatedAt: doc.updatedAt,
      ...(doc.updatedBy !== undefined && { updatedBy: doc.updatedBy }),
    });
  }
}

export class InMemoryControlState implements ControlState {
  readonly inbox: InboxStore = new InMemoryInboxStore();
  readonly sessions: SessionStore = new InMemorySessionStore();
  readonly threads: ThreadStore;
  readonly leases: LeaseStore;
  readonly channels: ChannelStateStore = new InMemoryChannelStateStore();

  constructor(now: () => number = Date.now) {
    this.threads = new InMemoryThreadStore(now);
    this.leases = new InMemoryLeaseStore(now);
  }
}
