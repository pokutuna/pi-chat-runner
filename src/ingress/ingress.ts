// Ingress IF — docs/design/architecture.md §1
//
// 「イベントの届き方 + ACK の仕方」を抽象化する Trigger 層。Socket Mode と
// Events API (Step 5) で実装を差し替え、後段 (dedupe/起動判定/inbox) は共通化する。

import type { ChatEvent } from "./chat-event.js";

export type Ack = () => Promise<void>;

export interface Ingress {
	/** 受信を開始。onEvent は dedupe・起動判定・inbox 積みの共通パイプライン */
	start(onEvent: (e: ChatEvent, ack: Ack) => Promise<void>): Promise<void>;
	stop(): Promise<void>;
}
