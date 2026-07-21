// StateStore の共通コントラクトテスト (docs/design/persistence.md §1)
//
// InMemory / SQLite など複数の実装が同じ振る舞いをすべきなので、
// インタフェースに対するテストを 1 セットだけ書き、実装ごとにパラメタライズして流す。

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { InboundMessage } from "../../../src/ingress/chat-event.js";
import type {
  ChannelSessionPointer,
  ChannelStateDoc,
  InboxItem,
  SessionDoc,
  StateStore,
} from "../../../src/store/state/interfaces.js";

export interface StateStoreHarness {
  store: StateStore;
  /** 時計を進める。省略時は実待ち (setTimeout) でテストする。 */
  advanceTime?: (ms: number) => void;
  close?: () => void;
}

function makeInboundMessage(id: string): InboundMessage {
  return {
    kind: "message",
    id,
    conversation: { channelId: "C1", threadTs: "1000.0" },
    sender: { id: "U1", isBot: false, isSelf: false },
    text: `hello ${id}`,
    mentionsBot: true,
    attachments: [],
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    metadata: {},
  };
}

function makeItem(id: string): InboxItem {
  return {
    id,
    event: makeInboundMessage(id),
    enqueuedAt: new Date("2026-01-01T00:00:01.000Z"),
  };
}

/** advanceTime があればそれで、無ければ実待ちで時間経過をシミュレートする。 */
async function passTime(harness: StateStoreHarness, ms: number): Promise<void> {
  if (harness.advanceTime) {
    harness.advanceTime(ms);
  } else {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function describeStateStoreContract(
  name: string,
  factory: () => Promise<StateStoreHarness>,
): void {
  describe(`StateStore contract: ${name}`, () => {
    let harness: StateStoreHarness;

    beforeEach(async () => {
      harness = await factory();
    });

    afterEach(() => {
      harness.close?.();
    });

    describe("InboxStore", () => {
      it("dedupe: 同 id の 2 回目は false", async () => {
        const threadKey = "T1";
        const item = makeItem("evt-1");
        expect(await harness.store.inbox.enqueue(threadKey, item)).toBe(true);
        expect(await harness.store.inbox.enqueue(threadKey, item)).toBe(false);
      });

      it("ack 後も同 id の再 enqueue は false", async () => {
        const threadKey = "T1";
        const item = makeItem("evt-1");
        await harness.store.inbox.enqueue(threadKey, item);
        await harness.store.inbox.ack(threadKey, [item.id]);
        expect(await harness.store.inbox.enqueue(threadKey, item)).toBe(false);
      });

      it("drain は未 ack 全件を enqueue 順に返す", async () => {
        const threadKey = "T1";
        const item1 = makeItem("evt-1");
        const item2 = makeItem("evt-2");
        await harness.store.inbox.enqueue(threadKey, item1);
        await harness.store.inbox.enqueue(threadKey, item2);

        const drained = await harness.store.inbox.drain(threadKey);
        expect(drained.map((i) => i.id)).toEqual(["evt-1", "evt-2"]);
      });

      it("drain は非破壊 (2 回呼んでも同じ結果)", async () => {
        const threadKey = "T1";
        await harness.store.inbox.enqueue(threadKey, makeItem("evt-1"));

        const first = await harness.store.inbox.drain(threadKey);
        const second = await harness.store.inbox.drain(threadKey);
        expect(first.map((i) => i.id)).toEqual(["evt-1"]);
        expect(second.map((i) => i.id)).toEqual(["evt-1"]);
      });

      it("ack した item は以後 drain に出ない", async () => {
        const threadKey = "T1";
        const item = makeItem("evt-1");
        await harness.store.inbox.enqueue(threadKey, item);
        await harness.store.inbox.ack(threadKey, [item.id]);

        const drained = await harness.store.inbox.drain(threadKey);
        expect(drained).toEqual([]);
      });

      it("部分 ack: ack した分だけ drain から消える", async () => {
        const threadKey = "T1";
        const item1 = makeItem("evt-1");
        const item2 = makeItem("evt-2");
        await harness.store.inbox.enqueue(threadKey, item1);
        await harness.store.inbox.enqueue(threadKey, item2);
        await harness.store.inbox.ack(threadKey, [item1.id]);

        const drained = await harness.store.inbox.drain(threadKey);
        expect(drained.map((i) => i.id)).toEqual(["evt-2"]);
      });

      it("thread_key ごとに独立している", async () => {
        await harness.store.inbox.enqueue("T1", makeItem("evt-1"));
        await harness.store.inbox.enqueue("T2", makeItem("evt-1"));

        expect(
          (await harness.store.inbox.drain("T1")).map((i) => i.id),
        ).toEqual(["evt-1"]);
        expect(
          (await harness.store.inbox.drain("T2")).map((i) => i.id),
        ).toEqual(["evt-1"]);
      });

      it("event の内容 (Date 含む) が往復する", async () => {
        const threadKey = "T1";
        const item = makeItem("evt-1");
        await harness.store.inbox.enqueue(threadKey, item);

        const [drained] = await harness.store.inbox.drain(threadKey);
        expect(drained).toBeDefined();
        expect(drained?.id).toBe(item.id);
        expect(drained?.event).toEqual(item.event);
        expect(drained?.event.timestamp).toBeInstanceOf(Date);
        expect(drained?.event.timestamp.getTime()).toBe(
          item.event.timestamp.getTime(),
        );
      });
    });

    describe("SessionStore", () => {
      it("get: 無ければ null", async () => {
        expect(await harness.store.sessions.get("T1")).toBeNull();
      });

      it("put/get: 往復する (Date 含む)", async () => {
        const doc: SessionDoc = {
          channelId: "C1",
          threadTs: "1000.0",
          triggerMessageId: "1000.0",
          status: "active",
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        };
        await harness.store.sessions.put("T1", doc);

        const got = await harness.store.sessions.get("T1");
        expect(got).toEqual(doc);
        expect(got?.updatedAt).toBeInstanceOf(Date);
      });

      it("put/get: rotateRequestedAt を含む doc は Date として往復する", async () => {
        const doc: SessionDoc = {
          channelId: "C1",
          threadTs: "1000.0",
          triggerMessageId: "1000.0",
          status: "active",
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          rotateRequestedAt: new Date("2026-01-01T00:00:05.000Z"),
        };
        await harness.store.sessions.put("T1", doc);

        const got = await harness.store.sessions.get("T1");
        expect(got).toEqual(doc);
        expect(got?.rotateRequestedAt).toBeInstanceOf(Date);
        expect(got?.rotateRequestedAt?.getTime()).toBe(
          doc.rotateRequestedAt?.getTime(),
        );
      });

      it("put/get: rotateRequestedAt を含まない doc は get 後も undefined のまま", async () => {
        const doc: SessionDoc = {
          channelId: "C1",
          threadTs: "1000.0",
          triggerMessageId: "1000.0",
          status: "active",
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        };
        await harness.store.sessions.put("T1", doc);

        const got = await harness.store.sessions.get("T1");
        expect(got?.rotateRequestedAt).toBeUndefined();
      });

      it("put: 同 thread_key への再 put は上書きする", async () => {
        const doc1: SessionDoc = {
          channelId: "C1",
          threadTs: "1000.0",
          triggerMessageId: "1000.0",
          status: "active",
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        };
        const doc2: SessionDoc = { ...doc1, status: "finished" };
        await harness.store.sessions.put("T1", doc1);
        await harness.store.sessions.put("T1", doc2);

        expect(await harness.store.sessions.get("T1")).toEqual(doc2);
      });
    });

    describe("ChannelStateStore", () => {
      it("get: 未知の channelId は null", async () => {
        expect(await harness.store.channels.get("C1")).toBeNull();
      });

      it("put/get: 往復する (Date 含む、updatedBy 込み)", async () => {
        const doc: ChannelStateDoc = {
          enabled: false,
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedBy: "U1",
        };
        await harness.store.channels.put("C1", doc);

        const got = await harness.store.channels.get("C1");
        expect(got).toEqual(doc);
        expect(got?.updatedAt).toBeInstanceOf(Date);
      });

      it("put/get: updatedBy を含まない doc は get 後も undefined のまま", async () => {
        const doc: ChannelStateDoc = {
          enabled: true,
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        };
        await harness.store.channels.put("C1", doc);

        const got = await harness.store.channels.get("C1");
        expect(got?.updatedBy).toBeUndefined();
      });

      it("put: 同 channelId への再 put は上書きする", async () => {
        const doc1: ChannelStateDoc = {
          enabled: true,
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        };
        const doc2: ChannelStateDoc = { ...doc1, enabled: false };
        await harness.store.channels.put("C1", doc1);
        await harness.store.channels.put("C1", doc2);

        expect(await harness.store.channels.get("C1")).toEqual(doc2);
      });

      describe("putSessionPointer (affinity)", () => {
        it("doc 未存在で putSessionPointer → get で enabled=true + affinity が返る", async () => {
          const pointer: ChannelSessionPointer = {
            sessionKey: "C1:1000.0",
            lastActiveAt: new Date("2026-01-01T00:00:00.000Z"),
          };
          await harness.store.channels.putSessionPointer("C1", pointer);

          const got = await harness.store.channels.get("C1");
          expect(got?.enabled).toBe(true);
          expect(got?.affinity).toEqual(pointer);
          expect(got?.affinity?.lastActiveAt).toBeInstanceOf(Date);
        });

        it("put (toggle) → putSessionPointer → get で両方残る", async () => {
          await harness.store.channels.put("C1", {
            enabled: false,
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedBy: "U1",
          });
          const pointer: ChannelSessionPointer = {
            sessionKey: "C1:1000.0",
            lastActiveAt: new Date("2026-01-01T00:00:05.000Z"),
          };
          await harness.store.channels.putSessionPointer("C1", pointer);

          const got = await harness.store.channels.get("C1");
          expect(got?.enabled).toBe(false);
          expect(got?.updatedBy).toBe("U1");
          expect(got?.affinity).toEqual(pointer);
        });

        it("putSessionPointer → put (toggle、affinity なしの doc を渡す) → get で affinity が残る", async () => {
          const pointer: ChannelSessionPointer = {
            sessionKey: "C1:1000.0",
            lastActiveAt: new Date("2026-01-01T00:00:00.000Z"),
          };
          await harness.store.channels.putSessionPointer("C1", pointer);
          await harness.store.channels.put("C1", {
            enabled: false,
            updatedAt: new Date("2026-01-01T00:00:10.000Z"),
            updatedBy: "U2",
          });

          const got = await harness.store.channels.get("C1");
          expect(got?.enabled).toBe(false);
          expect(got?.updatedBy).toBe("U2");
          expect(got?.affinity).toEqual(pointer);
        });

        it("putSessionPointer を endedAt 付き → endedAt なしで上書き → get で endedAt が消えている", async () => {
          const withEnded: ChannelSessionPointer = {
            sessionKey: "C1:1000.0",
            lastActiveAt: new Date("2026-01-01T00:00:00.000Z"),
            endedAt: new Date("2026-01-01T00:00:05.000Z"),
          };
          await harness.store.channels.putSessionPointer("C1", withEnded);

          const withoutEnded: ChannelSessionPointer = {
            sessionKey: "C1:1000.0",
            lastActiveAt: new Date("2026-01-01T00:00:10.000Z"),
          };
          await harness.store.channels.putSessionPointer("C1", withoutEnded);

          const got = await harness.store.channels.get("C1");
          expect(got?.affinity).toEqual(withoutEnded);
          expect(got?.affinity?.endedAt).toBeUndefined();
        });
      });
    });

    describe("LeaseStore", () => {
      it("acquire: 成功する", async () => {
        const lease = await harness.store.leases.acquire("T1", "owner-a", 1000);
        expect(lease).not.toBeNull();
        expect(lease?.threadKey).toBe("T1");
        expect(lease?.owner).toBe("owner-a");
      });

      it("acquire: 二重 acquire は null", async () => {
        await harness.store.leases.acquire("T1", "owner-a", 10_000);
        const second = await harness.store.leases.acquire(
          "T1",
          "owner-b",
          10_000,
        );
        expect(second).toBeNull();
      });

      it("acquire: 期限切れ後は奪える (token が増える)", async () => {
        const first = await harness.store.leases.acquire("T1", "owner-a", 10);
        expect(first).not.toBeNull();

        await passTime(harness, 20);

        const second = await harness.store.leases.acquire(
          "T1",
          "owner-b",
          10_000,
        );
        expect(second).not.toBeNull();
        expect(second?.owner).toBe("owner-b");
        expect(second?.token).toBeGreaterThan(first?.token ?? -1);
      });

      it("renew: 成功する", async () => {
        const lease = await harness.store.leases.acquire(
          "T1",
          "owner-a",
          10_000,
        );
        expect(lease).not.toBeNull();
        if (lease === null) throw new Error("unreachable");

        const renewed = await harness.store.leases.renew(lease, 10_000);
        expect(renewed).toBe(true);
      });

      it("renew: 期限切れなら失敗する", async () => {
        const lease = await harness.store.leases.acquire("T1", "owner-a", 10);
        expect(lease).not.toBeNull();
        if (lease === null) throw new Error("unreachable");

        await passTime(harness, 20);

        const renewed = await harness.store.leases.renew(lease, 10_000);
        expect(renewed).toBe(false);
      });

      it("renew: 古い token では失敗する", async () => {
        const first = await harness.store.leases.acquire("T1", "owner-a", 10);
        expect(first).not.toBeNull();
        if (first === null) throw new Error("unreachable");

        await passTime(harness, 20);
        await harness.store.leases.acquire("T1", "owner-b", 10_000);

        const renewed = await harness.store.leases.renew(first, 10_000);
        expect(renewed).toBe(false);
      });

      it("release: token 一致で削除し、以後 acquire できる", async () => {
        const lease = await harness.store.leases.acquire(
          "T1",
          "owner-a",
          10_000,
        );
        expect(lease).not.toBeNull();
        if (lease === null) throw new Error("unreachable");

        await harness.store.leases.release(lease);

        const reacquired = await harness.store.leases.acquire(
          "T1",
          "owner-b",
          10_000,
        );
        expect(reacquired).not.toBeNull();
      });

      it("release: 古い token では効かない", async () => {
        const first = await harness.store.leases.acquire("T1", "owner-a", 10);
        expect(first).not.toBeNull();
        if (first === null) throw new Error("unreachable");

        await passTime(harness, 20);
        const second = await harness.store.leases.acquire(
          "T1",
          "owner-b",
          10_000,
        );
        expect(second).not.toBeNull();

        // 古い lease (奪われる前の token) で release しても、現行の lease は消えない
        await harness.store.leases.release(first);

        const renewed = await harness.store.leases.renew(
          second as NonNullable<typeof second>,
          10_000,
        );
        expect(renewed).toBe(true);
      });

      it("thread_key ごとに独立している", async () => {
        const leaseA = await harness.store.leases.acquire(
          "T1",
          "owner-a",
          10_000,
        );
        const leaseB = await harness.store.leases.acquire(
          "T2",
          "owner-a",
          10_000,
        );
        expect(leaseA).not.toBeNull();
        expect(leaseB).not.toBeNull();
      });
    });
  });
}
