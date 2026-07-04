import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/server.ts"],
	outDir: "dist",
	format: "esm",
	platform: "node",
	target: "node26",
	sourcemap: true,
	clean: true,
});
