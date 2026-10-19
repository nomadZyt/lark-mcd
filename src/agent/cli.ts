import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type AppConfig } from "../bot/config.js";
import { applyEnvFile } from "../bot/env-file.js";
import { GuardError, McpGuard } from "../core/guard.js";
import { HttpMcpClient, type McpClient } from "../core/mcp-client.js";
import { loadFixtures, MockMcpClient } from "../core/mock-mcp.js";
import { redact } from "../core/parse.js";
import { AgentError } from "./errors.js";
import { LarkDmNotifier, type ProposalNotifier } from "./feishu-dm.js";
import { FileMenuCache, type MenuCache } from "./menu-cache.js";
import { FileProposalStore, type ProposalStore } from "./proposal-store.js";
import { FileRateLimiter, type RateLimiter } from "./rate-limit.js";
import { envelope, parseAgentArgv, runCommand, type CommandContext } from "./run.js";

export const AGENT_HELP = [
  "lark-mcd agent <命令> --json",
  "",
  "命令：",
  "  stores --near \"城市 关键词\"",
  "  menu --store <storeCode>",
  "  quote --store <storeCode> --items '[{\"code\":\"1440\",\"qty\":1}]'",
  "  propose --quote <quoteId>",
  "  status [--order <orderId>]",
  "",
  "没有下单或取消命令。下单只在飞书卡片上由 Token 主人点确认。",
  "需要环境变量 LARK_MCD_AGENT=1。不要放进 cron、heartbeat 或定时任务。",
  "Token 只从本机环境变量或 .env 读取，不会出现在 JSON 里。",
  "不要把 Token 填进 WorkBuddy、OpenClaw 或 Hermes 去直连麦当劳 MCP。",
].join("\n");

export interface AgentRuntime {
  env: NodeJS.ProcessEnv;
  now?: () => number;
  mcp?: McpClient;
  proposals?: ProposalStore;
  limiter?: RateLimiter;
  notifier?: ProposalNotifier;
  menuCache?: MenuCache;
}

export interface AgentRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function executeAgent(argv: string[], runtime: AgentRuntime): Promise<AgentRunResult> {
  const parsed = parseAgentArgv(argv);
  if (parsed.kind === "help") return { code: 0, stdout: `${AGENT_HELP}\n`, stderr: "" };
  if (parsed.kind === "error") return fail(parsed.command, parsed.code, parsed.message, runtime);
  if (runtime.env.LARK_MCD_AGENT !== "1") {
    return fail(
      parsed.command.type,
      "NOT_CONFIGURED",
      "需要本机环境变量 LARK_MCD_AGENT=1 才运行 Agent 入口。不要放进 cron、heartbeat、定时任务或后台任务。",
      runtime,
    );
  }
  if (!parsed.json) {
    return fail(parsed.command.type, "BAD_ARGS", "请加上 --json。Agent 只读取 JSON。", runtime);
  }
  let config: AppConfig;
  try {
    config = loadConfig(runtime.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "配置无效";
    return fail(parsed.command.type, "NOT_CONFIGURED", message, runtime);
  }
  const now = runtime.now ?? (() => Date.now());
  const dir = dirname(config.statePath);
  const limiter = runtime.limiter ?? new FileRateLimiter(dir);
  try {
    limiter.take(now());
    const ctx: CommandContext = {
      config,
      mcp: runtime.mcp ?? openMcp(config),
      proposals: runtime.proposals ?? new FileProposalStore(dir),
      limiter,
      menuCache: runtime.menuCache ?? new FileMenuCache(dir),
      notifier: runtime.notifier ?? (config.feishuAppId && config.feishuAppSecret
        ? new LarkDmNotifier(config.feishuAppId, config.feishuAppSecret)
        : undefined),
      now,
    };
    if (parsed.command.type === "propose" && !ctx.notifier) {
      throw new AgentError("NOT_CONFIGURED", "缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET，无法把确认卡片推给 Token 主人");
    }
    const extra = await runCommand(parsed.command, ctx);
    const body = envelope(config, parsed.command.type, extra);
    return {
      code: 0,
      stdout: `${scrub(JSON.stringify(body), runtime)}\n`,
      stderr: `${parsed.command.type} 完成\n`,
    };
  } catch (error) {
    if (error instanceof AgentError) return fail(parsed.command.type, error.code, error.message, runtime);
    if (error instanceof GuardError) return fail(parsed.command.type, error.code, error.message, runtime);
    const message = error instanceof Error ? error.message : "处理失败";
    return fail(parsed.command.type, "MCP_ERROR", message, runtime);
  }
}

function openMcp(config: AppConfig): McpClient {
  const guard = new McpGuard({ ownerOpenId: config.ownerOpenId, dryRun: config.dryRun });
  if (config.mode === "mock") return new MockMcpClient(guard, loadFixtures());
  return new HttpMcpClient({ url: config.mcpUrl, token: config.token ?? "", guard });
}

function fail(command: string | undefined, code: string, message: string, runtime: AgentRuntime): AgentRunResult {
  const payload: Record<string, unknown> = { ok: false, code, message };
  if (command) payload.command = command;
  const stdout = `${scrub(JSON.stringify(payload), runtime)}\n`;
  let human = message;
  try {
    const parsed = JSON.parse(stdout) as { message?: string };
    if (typeof parsed.message === "string") human = parsed.message;
  } catch {
    human = message;
  }
  return { code: 1, stdout, stderr: `${code}：${human}\n` };
}

function scrub(text: string, runtime: AgentRuntime): string {
  let safe = redact(text);
  for (const key of ["MCD_MCP_TOKEN", "FEISHU_APP_SECRET"]) {
    const secret = runtime.env[key]?.trim();
    if (secret && secret.length >= 6) safe = safe.split(secret).join("[redacted]");
  }
  return safe;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  applyEnvFile(resolve(process.cwd(), ".env"), env);
  if (env.LARK_MCD_HOME) applyEnvFile(resolve(env.LARK_MCD_HOME, ".env"), env);
  const result = await executeAgent(argv, { env });
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === resolve(entry);
}

if (isDirectRun()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "启动失败";
      process.stderr.write(`${redact(message)}\n`);
      process.exitCode = 1;
    });
}
