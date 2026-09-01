import { defineConfig } from "tsup";

export default defineConfig({
  entry: { reviewx: "src/cli/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: false,
  external: ["next"],
  banner: { js: "#!/usr/bin/env node" },
});
