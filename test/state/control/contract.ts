// ControlState の共通コントラクトテスト (docs/design/state.md §4.3)
//
// InMemory / SQLite / Firestore の 3 実装が同じ振る舞いをすべきなので、
// インタフェースに対するテストを 1 セットだけ書き、実装ごとにパラメタライズして流す。
// backend 固有のテストではなく、この契約スイートに書くことが仕様の追加である。

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { InboundMessage } from "../../../src/ingress/chat-event.js";
import type {
  ChannelStateDoc,
  ControlState,
  InboxItem,
  SessionRecord,
} from "../../../src/state/control/interfaces.js";

export interface ControlStateHarness {
  store: ControlState;
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
async function passTime(
  harness: ControlStateHarness,
  ms: number,
): Promise<void> {
  if (harness.advanceTime) {
    harness.advanceTime(ms);
  } else {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function describeControlStateContract(
  name: string,
  factory: () => Promise<ControlStateHarness>,
): void {
  describe(`ControlState contract: ${name}`, () => {
    let harness: ControlStateHarness;

    beforeEach(async () => {
      harness = await factory();
    });

    afterEach(() => {
      harness.close?.();
    });

    describe("InboxStore", () => {
      it("dedupe: 同 id の 2 回目は false", async () => {
        const sessionKey = "S1";
        const item = makeItem("evt-1");
        expect(await harness.store.inbox.enqueue(sessionKey, item)).toBe(true);
        expect(await harness.store.inbox.enqueue(sessionKey, item)).toBe(false);
      });

      it("ack 後も同 id の再 enqueue は false", async () => {
        const sessionKey = "S1";
        const item = makeItem("evt-1");
        await harness.store.inbox.enqueue(sessionKey, item);
        await harness.store.inbox.ack(sessionKey, [item.id]);
        expect(await harness.store.inbox.enqueue(sessionKey, item)).toBe(false);
      });

      it("drain は未 ack 全件を enqueue 順に返す", async () => {
        const sessionKey = "S1";
        const item1 = makeItem("evt-1");
        const item2 = makeItem("evt-2");
        await harness.store.inbox.enqueue(sessionKey, item1);
        await harness.store.inbox.enqueue(sessionKey, item2);

        const drained = await harness.store.inbox.drain(sessionKey);
        expect(drained.map((i) => i.id)).toEqual(["evt-1", "evt-2"]);
      });

      it("drain は非破壊 (2 回呼んでも同じ結果)", async () => {
        const sessionKey = "S1";
        await harness.store.inbox.enqueue(sessionKey, makeItem("evt-1"));

        const first = await harness.store.inbox.drain(sessionKey);
        const second = await harness.store.inbox.drain(sessionKey);
        expect(first.map((i) => i.id)).toEqual(["evt-1"]);
        expect(second.map((i) => i.id)).toEqual(["evt-1"]);
      });

      it("ack した item は以後 drain に出ない", async () => {
        const sessionKey = "S1";
        const item = makeItem("evt-1");
        await harness.store.inbox.enqueue(sessionKey, item);
        await harness.store.inbox.ack(sessionKey, [item.id]);

        const drained = await harness.store.inbox.drain(sessionKey);
        expect(drained).toEqual([]);
      });

      it("部分 ack: ack した分だけ drain から消える", async () => {
        const sessionKey = "S1";
        const item1 = makeItem("evt-1");
        const item2 = makeItem("evt-2");
        await harness.store.inbox.enqueue(sessionKey, item1);
        await harness.store.inbox.enqueue(sessionKey, item2);
        await harness.store.inbox.ack(sessionKey, [item1.id]);

        const drained = await harness.store.inbox.drain(sessionKey);
        expect(drained.map((i) => i.id)).toEqual(["evt-2"]);
      });

      it("sessionKey ごとに独立している", async () => {
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
        const sessionKey = "S1";
        const item = makeItem("evt-1");
        await harness.store.inbox.enqueue(sessionKey, item);

        const [drained] = await harness.store.inbox.drain(sessionKey);
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
      const base: SessionRecord = {
        channelId: "C1",
        threadTs: "1000.0",
        triggerMessageId: "1000.0",
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        lastActiveAt: new Date("2026-01-01T00:00:03.000Z"),
      };

      it("get: 無ければ null", async () => {
        expect(await harness.store.sessions.get("S1")).toBeNull();
      });

      it("put/get: 往復する (Date 含む)", async () => {
        await harness.store.sessions.put("S1", base);

        const got = await harness.store.sessions.get("S1");
        expect(got).toEqual(base);
        expect(got?.startedAt).toBeInstanceOf(Date);
        expect(got?.lastActiveAt).toBeInstanceOf(Date);
        // 旧 SessionDoc の status は廃止済み (state.md §3.2)
        expect(got).not.toHaveProperty("status");
      });

      it("put/get: endedAt を含む record は Date として往復する", async () => {
        const record: SessionRecord = {
          ...base,
          endedAt: new Date("2026-01-01T00:00:09.000Z"),
        };
        await harness.store.sessions.put("S1", record);

        const got = await harness.store.sessions.get("S1");
        expect(got).toEqual(record);
        expect(got?.endedAt).toBeInstanceOf(Date);
      });

      it("put/get: endedAt を含まない record は get 後も undefined のまま (= 稼働中)", async () => {
        await harness.store.sessions.put("S1", base);

        expect(
          (await harness.store.sessions.get("S1"))?.endedAt,
        ).toBeUndefined();
      });

      it("put/get: rotateRequestedAt を含む record は Date として往復する", async () => {
        const record: SessionRecord = {
          ...base,
          rotateRequestedAt: new Date("2026-01-01T00:00:05.000Z"),
        };
        await harness.store.sessions.put("S1", record);

        const got = await harness.store.sessions.get("S1");
        expect(got).toEqual(record);
        expect(got?.rotateRequestedAt).toBeInstanceOf(Date);
        expect(got?.rotateRequestedAt?.getTime()).toBe(
          record.rotateRequestedAt?.getTime(),
        );
      });

      it("put/get: rotateRequestedAt を含まない record は get 後も undefined のまま", async () => {
        await harness.store.sessions.put("S1", base);

        expect(
          (await harness.store.sessions.get("S1"))?.rotateRequestedAt,
        ).toBeUndefined();
      });

      it("put: 同 sessionKey への再 put は上書きする (endedAt もクリアできる)", async () => {
        const ended: SessionRecord = {
          ...base,
          endedAt: new Date("2026-01-01T00:00:09.000Z"),
        };
        await harness.store.sessions.put("S1", ended);
        await harness.store.sessions.put("S1", base);

        expect(await harness.store.sessions.get("S1")).toEqual(base);
      });
    });

    describe("ThreadStore", () => {
      it("resolve: 未登録の threadKey は null", async () => {
        expect(await harness.store.threads.resolve("C1:1000.0")).toBeNull();
      });

      it("bind → resolve で合流先 sessionKey が返る", async () => {
        await harness.store.threads.bind("C1:1000.0", "C1:900.0");

        expect(await harness.store.threads.resolve("C1:1000.0")).toBe(
          "C1:900.0",
        );
      });

      it("bind: 同 threadKey への再 bind は上書きする", async () => {
        await harness.store.threads.bind("C1:1000.0", "C1:900.0");
        await harness.store.threads.bind("C1:1000.0", "C1:800.0");

        expect(await harness.store.threads.resolve("C1:1000.0")).toBe(
          "C1:800.0",
        );
      });

      it("latest: 未登録の channelId は null", async () => {
        expect(await harness.store.threads.latest("C1")).toBeNull();
      });

      it("touchLatest → latest が lastActiveAt 付きで返る (endedAt は undefined)", async () => {
        await harness.store.threads.touchLatest("C1", "C1:1000.0");

        const latest = await harness.store.threads.latest("C1");
        expect(latest?.sessionKey).toBe("C1:1000.0");
        expect(latest?.lastActiveAt).toBeInstanceOf(Date);
        expect(latest?.endedAt).toBeUndefined();
      });

      it("touchLatest: 別 sessionKey で呼ぶと直近が差し替わる", async () => {
        await harness.store.threads.touchLatest("C1", "C1:1000.0");
        await passTime(harness, 10);
        await harness.store.threads.touchLatest("C1", "C1:2000.0");

        expect((await harness.store.threads.latest("C1"))?.sessionKey).toBe(
          "C1:2000.0",
        );
      });

      it("markLatestEnded → endedAt が入り、sessionKey は保たれる", async () => {
        await harness.store.threads.touchLatest("C1", "C1:1000.0");
        await passTime(harness, 10);
        await harness.store.threads.markLatestEnded("C1", "C1:1000.0");

        const latest = await harness.store.threads.latest("C1");
        expect(latest?.sessionKey).toBe("C1:1000.0");
        expect(latest?.endedAt).toBeInstanceOf(Date);
      });

      it("markLatestEnded: 直近でない sessionKey を渡しても何も起きない", async () => {
        await harness.store.threads.touchLatest("C1", "C1:1000.0");
        await passTime(harness, 10);
        await harness.store.threads.touchLatest("C1", "C1:2000.0");
        // 古い Session の終了で「最後に活動した Session」を巻き戻さない
        await harness.store.threads.markLatestEnded("C1", "C1:1000.0");

        const latest = await harness.store.threads.latest("C1");
        expect(latest?.sessionKey).toBe("C1:2000.0");
        expect(latest?.endedAt).toBeUndefined();
      });

      it("touchLatest: 終了済みの直近を touch すると endedAt がクリアされる", async () => {
        await harness.store.threads.touchLatest("C1", "C1:1000.0");
        await harness.store.threads.markLatestEnded("C1", "C1:1000.0");
        await passTime(harness, 10);
        await harness.store.threads.touchLatest("C1", "C1:1000.0");

        expect(
          (await harness.store.threads.latest("C1"))?.endedAt,
        ).toBeUndefined();
      });

      it("channel ごとに独立している", async () => {
        await harness.store.threads.touchLatest("C1", "C1:1000.0");
        await harness.store.threads.touchLatest("C2", "C2:1000.0");
        await harness.store.threads.bind("C1:1000.0", "C1:900.0");

        expect((await harness.store.threads.latest("C1"))?.sessionKey).toBe(
          "C1:1000.0",
        );
        expect((await harness.store.threads.latest("C2"))?.sessionKey).toBe(
          "C2:1000.0",
        );
        expect(await harness.store.threads.resolve("C2:1000.0")).toBeNull();
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
    });

    describe("LeaseStore", () => {
      it("acquire: 成功する", async () => {
        const lease = await harness.store.leases.acquire("T1", "owner-a", 1000);
        expect(lease).not.toBeNull();
        expect(lease?.sessionKey).toBe("T1");
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

      it("sessionKey ごとに独立している", async () => {
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
