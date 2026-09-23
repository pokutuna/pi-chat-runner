import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/server.ts",
    "src/index.ts",
    "src/state/control/firestore.ts",
    "src/state/control/sqlite.ts",
  ],
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node26",
  sourcemap: true,
  dts: true,
  clean: true,
});
