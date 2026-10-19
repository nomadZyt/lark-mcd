import { z } from "zod";
import { defaultStatePath } from "./state.js";

const envSchema = z.object({
  MCD_MODE: z.enum(["mock", "real"]).optional(),
  MCD_MCP_TOKEN: z.string().optional(),
  MCD_MCP_URL: z.string().optional(),
  FEISHU_APP_ID: z.string().optional(),
  FEISHU_APP_SECRET: z.string().optional(),
  OWNER_OPEN_ID: z.string().optional(),
  DRY_RUN: z.string().optional(),
  STATE_PATH: z.string().optional(),
});

export interface AppConfig {
  mode: "mock" | "real";
  token?: string;
  mcpUrl: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  ownerOpenId: string;
  dryRun: boolean;
  statePath: string;
}

function blank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.parse({
    MCD_MODE: blank(env.MCD_MODE),
    MCD_MCP_TOKEN: env.MCD_MCP_TOKEN,
    MCD_MCP_URL: env.MCD_MCP_URL,
    FEISHU_APP_ID: env.FEISHU_APP_ID,
    FEISHU_APP_SECRET: env.FEISHU_APP_SECRET,
    OWNER_OPEN_ID: env.OWNER_OPEN_ID,
    DRY_RUN: env.DRY_RUN,
    STATE_PATH: env.STATE_PATH,
  });
  const token = blank(parsed.MCD_MCP_TOKEN);
  const mode = parsed.MCD_MODE ?? (token ? "real" : "mock");
  const dryRun = parsed.DRY_RUN !== "false";
  const ownerOpenId = blank(parsed.OWNER_OPEN_ID) ?? (mode === "mock" ? "demo-owner" : "");
  if (mode === "real" && !token) {
    throw new Error("MCD_MODE=real 需要本机环境变量 MCD_MCP_TOKEN");
  }
  if (mode === "real" && !ownerOpenId) {
    throw new Error("真实模式需要 OWNER_OPEN_ID，这样才不会替别人调用 MCP");
  }
  return {
    mode,
    token,
    mcpUrl: blank(parsed.MCD_MCP_URL) ?? "https://mcp.mcd.cn",
    feishuAppId: blank(parsed.FEISHU_APP_ID),
    feishuAppSecret: blank(parsed.FEISHU_APP_SECRET),
    ownerOpenId,
    dryRun,
    statePath: blank(parsed.STATE_PATH) ?? defaultStatePath(),
  };
}
