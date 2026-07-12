// SocketIngress — Slack Socket Mode 経由の Ingress — docs/design/architecture.md §1

import { SocketModeClient } from "@slack/socket-mode";
import type { WebClient } from "@slack/web-api";

import type { Logger } from "../../logger.js";
import type { ChatEvent } from "../chat-event.js";
import type { Ack, Ingress } from "../ingress.js";
import { SlackIngressAdapter, type SlackRawEvent } from "./adapter.js";

/** Slack Socket Mode 経由の Ingress。ローカル確認・お試し用途
 * (architecture.md §1)。SlackIngressAdapter で正規化し、envelope の ack を Ack として渡す。
 * Socket Mode の接続確立自体は presence には反映されないため (RUNNER_TODO.md)、
 * 接続後に users.setPresence を能動的に呼んでオンライン表示にする。 */
export class SocketIngress implements Ingress {
  private readonly client: SocketModeClient;
  private readonly adapter: SlackIngressAdapter;
  private readonly web: WebClient | undefined;
  private readonly logger: Logger | undefined;

  constructor(opts: {
    appToken: string;
    botUserId: string;
    web?: WebClient;
    logger?: Logger;
  }) {
    this.client = new SocketModeClient({ appToken: opts.appToken });
    this.adapter = new SlackIngressAdapter(opts.botUserId);
    this.web = opts.web;
    this.logger = opts.logger;
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

    this.client.on("connected", () => {
      void this.setPresenceAuto();
    });

    await this.client.start();
  }

  /** users.setPresence({presence: "auto"}) を叩く。web 未指定時は何もしない
   * (WebClient 注入はテスト・省略可能にするための opt-in)。失敗しても接続自体は
   * 継続させたいので例外は握りつぶし、warn ログのみ残す。 */
  private async setPresenceAuto(): Promise<void> {
    if (this.web === undefined) return;
    try {
      await this.web.users.setPresence({ presence: "auto" });
    } catch (err) {
      this.logger?.warn({ err }, "users.setPresence failed");
    }
  }

  async stop(): Promise<void> {
    await this.client.disconnect();
  }
}
