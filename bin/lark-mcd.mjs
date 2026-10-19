#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));

let loader;
try {
  loader = require.resolve("tsx");
} catch {
  process.stderr.write("找不到 tsx。请在 lark-mcd 仓库里执行 npm install。\n");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--import", loader, join(root, "src/agent/cli.ts"), ...process.argv.slice(2)],
  { stdio: "inherit" },
);
if (result.error) {
  process.stderr.write("无法启动 lark-mcd。\n");
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
