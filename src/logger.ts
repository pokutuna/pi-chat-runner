// 構造化ログの共通設定 (pino)。
//
// Cloud Run では非 TTY で 1 行 1 JSON を stdout に出す。ローカル開発 (TTY) だけ
// pino-pretty を通して読みやすくする。各コンポーネントは rootLogger.child({ component })
// で名前空間を分けて利用する。

import pino from "pino";

export type { Logger } from "pino";

export const rootLogger = pino({
	level: process.env.LOG_LEVEL ?? "info",
	...(process.stdout.isTTY ? { transport: { target: "pino-pretty" } } : {}),
});
