import { renderCardText } from "../cards/render.js";
import { McpGuard } from "../core/guard.js";
import { loadFixtures, MockMcpClient } from "../core/mock-mcp.js";
import { NEXT_STEPS } from "../extensions.js";
import { OrderFlow } from "../bot/flow.js";
import { SessionBook } from "../bot/session.js";
import { loadDemoState, MemoryStateStore } from "../bot/state.js";

const owner = "demo-owner";

function count(mcp: MockMcpClient, tool: string): number {
  return mcp.calls.filter((call) => call.tool === tool).length;
}

async function main(): Promise<void> {
  const fixtures = loadFixtures();
  const guard = new McpGuard({ ownerOpenId: owner, dryRun: true });
  const mcp = new MockMcpClient(guard, fixtures);
  const flow = new OrderFlow(mcp, new MemoryStateStore(loadDemoState()), new SessionBook(), {
    ownerOpenId: owner,
    dryRun: true,
    now: () => Date.parse("2026-10-19T12:00:00+08:00"),
  });

  console.log("麦麦卡片 · mock 演示");
  console.log("不连接麦当劳，不连接飞书，不会扣款。");
  console.log(fixtures.notice);
  console.log("");

  const priced = await flow.onMessage({
    eventId: "demo-msg-1",
    openId: owner,
    chatId: "demo-chat",
    chatType: "p2p",
    text: "老样子",
  });
  console.log("步骤 1  私聊「老样子」");
  if (!priced.card) throw new Error("没有生成核价卡片");
  console.log(renderCardText(priced.card));
  console.log("\n--- 卡片 JSON ---");
  console.log(JSON.stringify(priced.card, null, 2));

  const calculated = await flow.onCard({
    eventId: "demo-card-payback",
    operatorOpenId: owner,
    action: "payback.calc",
    sessionId: "d-demo-msg-1",
    form: { card_price: "19.9", freq: "3" },
  });
  console.log("\n步骤 2  点击「算一算」。卡价按你填写的 19.9 元，每周 3 次。");
  console.log("19.9 只是演示时填进输入框的数字，不是接口返回的卡价。");
  if (!calculated.card) throw new Error("没有生成小算盘卡片");
  console.log(renderCardText(calculated.card));

  const confirmed = await flow.onCard({
    eventId: "demo-card-confirm",
    operatorOpenId: owner,
    action: "order.confirm",
    sessionId: "d-demo-msg-1",
    form: {},
  });
  console.log("\n步骤 3  点击「确认下单」（DRY_RUN=true）");
  if (!confirmed.card) throw new Error("没有生成演练卡片");
  console.log(renderCardText(confirmed.card));
  if (count(mcp, "create-order") !== 0) {
    throw new Error("演练模式调用了 create-order");
  }
  console.log(`\n演练模式 MCP 次数：calculate-price ${count(mcp, "calculate-price")}，query-meals ${count(mcp, "query-meals")}，order-list ${count(mcp, "order-list")}，create-order ${count(mcp, "create-order")}`);

  await previewRealShape(fixtures);

  console.log("\n下一版：");
  for (const step of NEXT_STEPS) console.log(`- ${step.title}：${step.note}`);
}

async function previewRealShape(fixtures: ReturnType<typeof loadFixtures>): Promise<void> {
  const guard = new McpGuard({ ownerOpenId: owner, dryRun: false });
  const mcp = new MockMcpClient(guard, fixtures);
  const flow = new OrderFlow(mcp, new MemoryStateStore(loadDemoState()), new SessionBook(), {
    ownerOpenId: owner,
    dryRun: false,
    now: () => Date.parse("2026-10-19T12:00:00+08:00"),
  });
  await flow.onMessage({
    eventId: "preview-msg",
    openId: owner,
    chatId: "preview-chat",
    chatType: "p2p",
    text: "老样子",
  });
  const pay = await flow.onCard({
    eventId: "preview-confirm",
    operatorOpenId: owner,
    action: "order.confirm",
    sessionId: "d-preview-msg",
    form: {},
  });
  const refreshed = await flow.onCard({
    eventId: "preview-refresh",
    operatorOpenId: owner,
    action: "order.refresh",
    sessionId: "d-preview-msg",
    form: {},
  });
  console.log("\n步骤 4  本地 mock 预览：DRY_RUN=false 时卡片的样子。仍然不访问麦当劳。");
  if (!pay.card || !refreshed.card) throw new Error("预览卡片缺失");
  console.log(renderCardText(pay.card));
  console.log(renderCardText(refreshed.card));
  const create = mcp.calls.find((call) => call.tool === "create-order");
  if (!create || "withOrder" in create.args) throw new Error("预览下单参数不对");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
