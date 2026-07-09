// SocketIngress — Slack Socket Mode 経由の Ingress — docs/design/architecture.md §1

import { SocketModeClient } from "@slack/socket-mode";

import type { ChatEvent } from "../chat-event.js";
import type { Ack, Ingress } from "../ingress.js";
import { SlackIngressAdapter, type SlackRawEvent } from "./adapter.js";

/** Slack Socket Mode 経由の Ingress。ローカル確認・お試し用途
 * (architecture.md §1)。SlackIngressAdapter で正規化し、envelope の ack を Ack として渡す。 */
export class SocketIngress implements Ingress {
  private readonly client: SocketModeClient;
  private readonly adapter: SlackIngressAdapter;

  constructor(opts: { appToken: string; botUserId: string }) {
    this.client = new SocketModeClient({ appToken: opts.appToken });
    this.adapter = new SlackIngressAdapter(opts.botUserId);
  }

  async start(
    onEvent: (e: ChatEvent, ack: Ack) => Promise<void>,
  ): Promise<void> {
    this.client.on(
      "slack_event",
      async (args: {
        ack: (response?: unknown) => Promise<void>;
        type: string;
        body: { event_id?: string; event?: SlackRawEvent };
      }) => {
        const rawEvent = args.body.event;
        if (rawEvent === undefined) {
          // events_api 以外 (hello/disconnect 等は SocketModeClient 内部で処理済み)。
          // 未知の envelope も ack だけして無視する。
          await args.ack();
          return;
        }

        const chatEvent = this.adapter.normalize(rawEvent, args.body.event_id);
        const ack: Ack = () => args.ack();

        if (chatEvent === null) {
          // 対象外イベントも 3 秒 ACK の責務は果たす (architecture.md §6 フロー 1-3 相当)
          await ack();
          return;
        }

        await onEvent(chatEvent, ack);
      },
    );

    await this.client.start();
  }

  async stop(): Promise<void> {
    await this.client.disconnect();
  }
}
