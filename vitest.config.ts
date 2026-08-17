import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Vite resolves modules itself and does NOT read tsconfig.json "paths", so the
// @ebook/* aliases have to be repeated here or every cross-package import in a
// test fails to resolve. Keep in sync with tsconfig.json.
const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@ebook\/core$/,     replacement: `${pkg("ebook-core")}/index.ts` },
      { find: /^@ebook\/core\//,    replacement: `${pkg("ebook-core")}/` },
      { find: /^@ebook\/infra$/,    replacement: `${pkg("ebook-infra")}/index.ts` },
      { find: /^@ebook\/infra\//,   replacement: `${pkg("ebook-infra")}/` },
      { find: /^@ebook\/config$/,   replacement: `${pkg("ebook-config")}/index.ts` },
      { find: /^@ebook\/config\//,  replacement: `${pkg("ebook-config")}/` },
      { find: /^@\//,               replacement: fileURLToPath(new URL("./", import.meta.url)) },
    ],
  },
  test: {
    // packages/** is the ebook monorepo; lib/** covers the video engine (the
    // synthetic planner's pure passes are unit-tested there).
    include: ["packages/**/*.test.ts", "lib/**/*.test.ts"],
  },
});
