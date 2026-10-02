import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli/bin.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  clean: true,
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" },
});
