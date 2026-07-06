import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"src/server.ts",
		"src/index.ts",
		"src/store/firestore.ts",
		"src/store/sqlite.ts",
	],
	outDir: "dist",
	format: "esm",
	platform: "node",
	target: "node26",
	sourcemap: true,
	dts: true,
	clean: true,
});
