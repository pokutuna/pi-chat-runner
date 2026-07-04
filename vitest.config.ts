import { defineConfig } from "vitest/config";

// テストでロガーを明示注入しない箇所 (rootLogger の既定 child) が stdout を汚さないように、
// テスト実行時は既定で silent にする。ログ検証が必要なテストは個別に pino logger を注入する。
process.env.LOG_LEVEL ??= "silent";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
	},
});
