// Ingress ステージ — docs/design/architecture.md §5, docs/design/ingress-egress.md §3
//
// Ingress から届いた ChatEvent を、Gate 以降が扱える形まで均す共通処理。
// 順序は ack → kind フィルタ → isSelf 除外 → enrichEvent → 後段へ受け渡し。
//
// - ack を最初に行うのは、3 秒 ACK と長い実行を分離するため (architecture.md §5)。
//   ACK の意味 (Socket Mode の ack コールバック / Events API の 200) は Ack が
//   吸収しているので、ここでは「積む前に ack する」とだけ書けばよい。
// - 自己エコー (sender.isSelf) は設定に関わらず無条件に除外する (無限ループ防止)。
//   他 bot の投稿はここでは弾かず、Gate の allowBots 判定・Gate 木に委ねる
//   (config.md §4.3)。
// - enrichEvent を Gate より前に置くのは、sender gate の name 判定が解決済み
//   displayName を前提とするため (gates/sender.ts)。
//
// チャット固有の重複吸収 (Slack の app_mention + message 二重配送) は codec 側
// (src/ingress/slack/adapter.ts) が持つ。このステージはチャットを知らない。

import type { Logger } from "../logger.js";
import type { ChatEvent, InboundMessage, ReactionEvent } from "./chat-event.js";
import type { Ack, Ingress } from "./ingress.js";
import { enrichEvent, type UserResolver } from "./user-resolver.js";

/** Ingress ステージを通過したイベントの受け取り先 (実体は Gate → Dispatcher)。 */
export interface IngressSink {
  message(event: InboundMessage): Promise<void>;
  reaction(event: ReactionEvent): Promise<void>;
}

export interface IngressPipelineOptions {
  ingress: Ingress;
  /** 表示名と本文中の mention の解決 (ingress-egress.md §3)。 */
  userResolver: UserResolver;
  sink: IngressSink;
  logger: Logger;
}

/** ingress を起動し、ack → kind フィルタ → isSelf 除外 → enrich を通したイベントを
 * sink へ渡す。ingress.start と同じく、受信開始が済んだら resolve する
 * (以降のイベント処理は ack 後も継続する)。 */
export async function startIngressPipeline(
  options: IngressPipelineOptions,
): Promise<void> {
  const { ingress, userResolver, sink, logger } = options;

  await ingress.start(async (event: ChatEvent, ack: Ack) => {
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

    if (event.kind === "reaction") {
      if (event.sender.isSelf) {
        logger.info({ reason: "self_echo", kind: event.kind }, "event dropped");
        return;
      }
      try {
        // sender gate の name 判定のため、reaction も sender を解決してから渡す
        // (enrichEvent は reaction では sender のみ enrich する)
        const enriched = (await enrichEvent(
          event,
          userResolver,
        )) as ReactionEvent;
        await sink.reaction(enriched);
      } catch (err) {
        logger.error({ err }, "failed to handle reaction");
      }
      return;
    }

    if (event.kind !== "message") {
      logger.info(
        { reason: "unsupported_kind", kind: event.kind },
        "event dropped",
      );
      return;
    }

    if (event.sender.isSelf) {
      logger.info({ reason: "self_echo", eventId: event.id }, "event dropped");
      return;
    }

    // enrichEvent は kind を変えないため、message であることは維持される
    const enriched = (await enrichEvent(event, userResolver)) as InboundMessage;

    try {
      await sink.message(enriched);
    } catch (err) {
      logger.error({ eventId: enriched.id, err }, "failed to handle event");
    }
  });
}
