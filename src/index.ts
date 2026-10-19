import { resolve } from "node:path";
import { loadConfig } from "./bot/config.js";
import { applyEnvFile } from "./bot/env-file.js";
import { startBot } from "./bot/start.js";

applyEnvFile(resolve(process.cwd(), ".env"));

try {
  const config = loadConfig(process.env);
  await startBot(config);
} catch (error) {
  const message = error instanceof Error ? error.message : "启动失败";
  console.error(message);
  process.exitCode = 1;
}
