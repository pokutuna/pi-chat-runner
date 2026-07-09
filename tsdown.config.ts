import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/server.ts",
    "src/index.ts",
    "src/store/state/backends/firestore.ts",
    "src/store/state/backends/sqlite.ts",
  ],
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node26",
  sourcemap: true,
  dts: true,
  clean: true,
});
