// チャットのテキストコマンド (session-model.md §5)。`/new` と `/enable` `/disable` の
// 解析 (純関数) と、Control State の書き込み・通知文の送出を行うハンドラ。
// Gate を通過したメッセージ本文にのみ適用される。

import {
  ACK_NOTICE_TEXT,
  DISABLE_NOTICE_TEXT,
  ENABLE_NOTICE_TEXT,
  REJECT_NOTICE_TEXT,
} from "../egress/notices.js";
import { registerReplyDestination } from "../egress/reply-destination.js";
import type { EgressRouter } from "../egress/router.js";
import type { InboundMessage } from "../ingress/chat-event.js";
import type { Logger } from "../logger.js";
import type { ControlState } from "../state/control/interfaces.js";
import type { SessionPolicy } from "./policy.js";

/** チャットのテキストコマンド。/new は rest 付きを許容するが、/enable /disable は
 * 完全一致のみ (session-model.md §5 「本文完全一致」)。 */
export type ChatCommand =
  | { kind: "new"; rest?: string }
  | { kind: "enable" }
  | { kind: "disable" };

const NEW_PREFIX = "/new";
const ENABLE_COMMAND = "/enable";
const DISABLE_COMMAND = "/disable";

/** メッセージ本文を解析してコマンドを返す。純関数 (session-model.md §5):
 * - trim 後が "/new" に完全一致 → { kind: "new" }
 * - "/new" + 空白 (改行含む) + 残り → { kind: "new", rest: <残りを trim> }
 * - trim 後が "/enable" / "/disable" に完全一致 → { kind: "enable" } / { kind: "disable" }
 *   (後続テキストに意味がないため、rest 付きは誤爆防止でコマンド化しない)
 * - それ以外 (前方一致のみ、大文字小文字違い、前後に他の文字がある等) は null */
export function parseCommand(text: string): ChatCommand | null {
  const trimmed = text.trim();
  if (trimmed === ENABLE_COMMAND) return { kind: "enable" };
  if (trimmed === DISABLE_COMMAND) return { kind: "disable" };
  if (trimmed === NEW_PREFIX) {
    return { kind: "new" };
  }
  if (!trimmed.startsWith(NEW_PREFIX)) return null;
  const rest = trimmed.slice(NEW_PREFIX.length);
  if (!/^\s/.test(rest)) return null;
  const trimmedRest = rest.trim();
  if (trimmedRest === "") return { kind: "new" };
  return { kind: "new", rest: trimmedRest };
}

/** `/new` `/enable` `/disable` のハンドラが要る依存。Control State の書き込みと
 * 通知文の送出だけを行い、Session の起動 (dispatch) は呼び出し元の Dispatcher に
 * 戻す (dispatchNew の戻り値)。 */
export interface CommandHandlerDeps {
  controlState: ControlState;
  router: EgressRouter;
  logger: Logger;
  /** lease の owner 識別子 (Dispatcher と同じ値) */
  owner: string;
}

/** `/new` コマンドのマーカー書き込み用 lease TTL (session-model.md §5.1)。実行中との
 * 交錯を避けるためだけの短時間ロックなので、通常の dispatch 用 leaseTtlMs より短くてよい */
const NEW_COMMAND_LEASE_TTL_MS = 10_000;

/** コマンド (`/new` の拒否・ack、`/enable` `/disable` の ack) 通知の配達。thread_key は
 * registerReplyDestination が返したメッセージごとの宛先キー。abnormalShutdown と
 * 違い progress キー (sessionKey) は渡さない — 実行中 Session への通知がその Session の
 * 進捗メッセージを上書き消費してしまうため (Session は継続中で、進捗タイマーも
 * 生きている)。配達失敗はログのみで進行を止めない */
async function deliverCommandNotice(
  deps: CommandHandlerDeps,
  sessionKey: string,
  threadKey: string,
  text: string,
): Promise<void> {
  await deps.router.deliver({ thread_key: threadKey, text }).catch((err) => {
    deps.logger.warn({ sessionKey, err }, "command notice delivery failed");
  });
}

/** 実行中 Session がある Session への `/new` の拒否 (session-model.md §5.1)。
 * 実行中との交錯を避けるため、steer には流さず拒否通知を返す (v1 の割り切り) */
export async function rejectNewWhileRunning(
  deps: CommandHandlerDeps,
  sessionKey: string,
  event: InboundMessage,
  policy: SessionPolicy,
): Promise<void> {
  const threadKey = registerReplyDestination(deps.router, event, policy);
  await deliverCommandNotice(deps, sessionKey, threadKey, REJECT_NOTICE_TEXT);
  deps.logger.info({ sessionKey }, "transcript rotation rejected: running");
}

/** `/new` コマンドの処理 (session-model.md §5.1)。Gate を通過済み、かつこの Session に
 * 実行中の実体が無いことが呼び出し元で確定した後にのみ呼ばれる。短時間の lease を
 * 取得してマーカー (rotateRequestedAt) を書くだけで、即座の rotate はしない
 * (WorkdirStore の archive に旧 session.jsonl が残っており、次の restore で復元されて
 * 巻き戻るため。次の dispatch が restore 後に消費する)。
 *
 * 戻り値: 続きの指示 (`/new <text>`) があればその本文。呼び出し元はこれを新規
 * Session の入力として dispatch する。rest なしなら null (ack を配達済み) */
export async function handleNewCommand(
  deps: CommandHandlerDeps,
  sessionKey: string,
  channelId: string,
  policy: SessionPolicy,
  event: InboundMessage,
  cmd: Extract<ChatCommand, { kind: "new" }>,
): Promise<{ rest: string } | null> {
  const lease = await deps.controlState.leases.acquire(
    sessionKey,
    deps.owner,
    NEW_COMMAND_LEASE_TTL_MS,
  );
  if (lease === null) {
    const threadKey = registerReplyDestination(deps.router, event, policy);
    await deliverCommandNotice(deps, sessionKey, threadKey, REJECT_NOTICE_TEXT);
    deps.logger.info(
      { sessionKey },
      "transcript rotation rejected: lease unavailable",
    );
    return null;
  }
  try {
    const existing = await deps.controlState.sessions.get(sessionKey);
    if (existing !== null) {
      // lastActiveAt は据え置き — マーカー書き込みは「活動」ではないので
      // idle 判定を狂わせない (session-model.md §6)
      await deps.controlState.sessions.put(sessionKey, {
        ...existing,
        rotateRequestedAt: new Date(),
      });
    } else {
      const threadTs = event.conversation.threadTs ?? event.id;
      const now = new Date();
      await deps.controlState.sessions.put(sessionKey, {
        channelId,
        threadTs,
        triggerMessageId: event.id,
        startedAt: now,
        lastActiveAt: now,
        endedAt: now,
        rotateRequestedAt: now,
      });
    }
  } finally {
    await deps.controlState.leases.release(lease);
  }
  deps.logger.info({ sessionKey }, "transcript rotation requested");

  if (cmd.rest !== undefined) return { rest: cmd.rest };

  const threadKey = registerReplyDestination(deps.router, event, policy);
  await deliverCommandNotice(deps, sessionKey, threadKey, ACK_NOTICE_TEXT);
  return null;
}

/** `/enable` `/disable` コマンドの処理 (session-model.md §5.2)。Gate をバイパスして
 * 実行中 Session の有無に関わらず呼ばれる — 状態書き込みのみで Session の
 * プロセスとは競合しないため、実行中でも即座に反映する。冪等: 既に同じ状態
 * でも同じ ack を返す (分岐しない) */
export async function handleToggleCommand(
  deps: CommandHandlerDeps,
  sessionKey: string,
  channelId: string,
  policy: SessionPolicy,
  event: InboundMessage,
  cmd: Extract<ChatCommand, { kind: "enable" | "disable" }>,
): Promise<void> {
  const enabled = cmd.kind === "enable";
  await deps.controlState.channels.put(channelId, {
    enabled,
    updatedAt: new Date(),
    updatedBy: event.sender.id,
  });
  deps.logger.info(
    { channelId, updatedBy: event.sender.id },
    enabled ? "channel enabled via command" : "channel disabled via command",
  );

  const threadKey = registerReplyDestination(deps.router, event, policy);
  await deliverCommandNotice(
    deps,
    sessionKey,
    threadKey,
    enabled ? ENABLE_NOTICE_TEXT : DISABLE_NOTICE_TEXT,
  );
}
