import { dirname } from "node:path";
import { EventDispatcher, LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";
import { FileProposalStore } from "../agent/proposal-store.js";
import { McpGuard } from "../core/guard.js";
import { HttpMcpClient } from "../core/mcp-client.js";
import { loadFixtures, MockMcpClient } from "../core/mock-mcp.js";
import type { McpClient } from "../core/mcp-client.js";
import type { AppConfig } from "./config.js";
import { handleCardCallback, handleIncomingMessage } from "./dispatch.js";
import { LarkOutbound } from "./feishu.js";
import { OrderFlow } from "./flow.js";
import { SessionBook } from "./session.js";
import { FileStateStore } from "./state.js";

export async function startBot(config: AppConfig): Promise<void> {
  if (!config.feishuAppId || !config.feishuAppSecret) {
    throw new Error("缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET");
  }
  const guard = new McpGuard({ ownerOpenId: config.ownerOpenId, dryRun: config.dryRun });
  const mcp: McpClient =
    config.mode === "real"
      ? new HttpMcpClient({ url: config.mcpUrl, token: config.token ?? "", guard })
      : new MockMcpClient(guard, loadFixtures());
  const flow = new OrderFlow(mcp, new FileStateStore(config.statePath), new SessionBook(), {
    ownerOpenId: config.ownerOpenId,
    dryRun: config.dryRun,
    now: () => Date.now(),
    proposals: new FileProposalStore(dirname(config.statePath)),
  });
  const outbound = new LarkOutbound(config.feishuAppId, config.feishuAppSecret);
  const runtime = { flow, outbound, ownerOpenId: config.ownerOpenId };
  const dispatcher = new EventDispatcher({}).register({
    "im.message.receive_v1": async (data: unknown) => {
      handleIncomingMessage(data, runtime);
    },
    "card.action.trigger": async (data: unknown) => handleCardCallback(data, runtime),
  });
  const ws = new WSClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    loggerLevel: LoggerLevel.info,
  });
  console.log(`麦麦卡片已启动。mode=${config.mode} DRY_RUN=${config.dryRun}。长连接连上之后，再去飞书后台保存事件订阅。`);
  await ws.start({ eventDispatcher: dispatcher });
}
