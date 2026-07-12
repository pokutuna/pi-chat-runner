// SocketIngress のテスト。実 WebSocket 接続は張らず、SocketModeClient を
// EventEmitter 相当のフェイクに差し替えて "connected" イベントの挙動だけ検証する。
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const startMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const disconnectMock = vi
  .fn<() => Promise<void>>()
  .mockResolvedValue(undefined);

class FakeSocketModeClient extends EventEmitter {
  start = startMock;
  disconnect = disconnectMock;
}

vi.mock("@slack/socket-mode", () => ({
  SocketModeClient: FakeSocketModeClient,
}));

const { SocketIngress } =
  await import("../../../src/ingress/slack/socket-ingress.js");

function noop(): Promise<void> {
  return Promise.resolve();
}

describe("SocketIngress", () => {
  beforeEach(() => {
    startMock.mockClear();
    disconnectMock.mockClear();
  });

  it("calls users.setPresence(auto) when the socket connects", async () => {
    const setPresence = vi
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);
    const web = { users: { setPresence } } as never;

    const ingress = new SocketIngress({
      appToken: "xapp-test",
      botUserId: "UBOT123",
      web,
    });
    await ingress.start(async (_e, ack) => {
      await ack();
    });

    // start() 内で登録された "connected" ハンドラを発火させる
    (ingress as unknown as { client: FakeSocketModeClient }).client.emit(
      "connected",
    );
    await Promise.resolve();

    expect(setPresence).toHaveBeenCalledWith({ presence: "auto" });
  });

  it("does nothing on connect when web is not provided", async () => {
    const ingress = new SocketIngress({
      appToken: "xapp-test",
      botUserId: "UBOT123",
    });
    await ingress.start(noop as never);

    expect(() => {
      (ingress as unknown as { client: FakeSocketModeClient }).client.emit(
        "connected",
      );
    }).not.toThrow();
  });

  it("swallows users.setPresence errors without throwing", async () => {
    const setPresence = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("boom"));
    const web = { users: { setPresence } } as never;
    const warn = vi.fn<(...args: unknown[]) => void>();

    const ingress = new SocketIngress({
      appToken: "xapp-test",
      botUserId: "UBOT123",
      web,
      logger: { warn } as never,
    });
    await ingress.start(noop as never);

    (ingress as unknown as { client: FakeSocketModeClient }).client.emit(
      "connected",
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(setPresence).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});
