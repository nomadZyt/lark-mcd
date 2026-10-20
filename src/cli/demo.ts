import { cardHasPaymentLink } from "../cards/build.js";
import { renderCardText } from "../cards/render.js";
import { McpGuard } from "../core/guard.js";
import { allocateFen } from "../core/aa.js";
import { loadFixtures, MockMcpClient } from "../core/mock-mcp.js";
import { NEXT_STEPS } from "../extensions.js";
import { OrderFlow } from "../bot/flow.js";
import { GroupFlow } from "../bot/group-flow.js";
import { MemoryLedger } from "../bot/ledger.js";
import { SessionBook } from "../bot/session.js";
import { loadDemoState, MemoryStateStore } from "../bot/state.js";
import type { CardInput } from "../bot/flow.js";

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
  await previewGroup(fixtures);

  console.log("\n还没做：");
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

async function previewGroup(fixtures: ReturnType<typeof loadFixtures>): Promise<void> {
  const guard = new McpGuard({ ownerOpenId: owner, dryRun: true });
  const mcp = new MockMcpClient(guard, fixtures);
  const state = new MemoryStateStore(loadDemoState());
  const orders = new OrderFlow(mcp, state, new SessionBook(), {
    ownerOpenId: owner,
    dryRun: true,
    now: () => Date.parse("2026-10-19T12:00:00+08:00"),
  });
  const ledger = new MemoryLedger();
  const group = new GroupFlow(mcp, state, ledger, orders, {
    ownerOpenId: owner,
    now: () => Date.parse("2026-10-19T12:00:00+08:00"),
  });
  console.log("\n步骤 5  群里 @机器人 /麦麦 拼单 午饭 12:00");
  const opened = await group.onMessage({
    eventId: "group-msg-1",
    openId: owner,
    chatId: "group-chat",
    chatType: "group",
    text: "/麦麦 拼单 午饭 12:00",
  });
  if (!opened.card) throw new Error("没有生成投票卡");
  console.log(renderCardText(opened.card));
  const beforeTicks = mcp.calls.length;
  await group.onCard(groupClick("group.tick", "member-a", { productCode: "1440", delta: 1, operatorName: "小王" }));
  await group.onCard(groupClick("group.tick", "member-b", { productCode: "1700", delta: 1, operatorName: "小李" }));
  await group.onCard(groupClick("group.tick", "member-a", { productCode: "1440", delta: 1, operatorName: "小王" }));
  if (mcp.calls.length !== beforeTicks) throw new Error("成员勾选调用了 MCP");
  const refused = await group.onCard(groupClick("group.close", "member-a", { operatorName: "小王" }));
  if (!refused.toast?.content.includes("只有发起人")) throw new Error("非发起人截止了拼单");
  if (mcp.calls.length !== beforeTicks) throw new Error("非发起人截止调用了 MCP");
  console.log("\n步骤 6  小王、小李勾选，非发起人点截止。勾选和拒绝都没有调用 MCP。");

  const priced = await group.onCard(groupClick("group.close", owner));
  if (!priced.card) throw new Error("没有生成核价卡");
  console.log("\n步骤 7  发起人截止并核价");
  console.log(renderCardText(priced.card));
  const sample = allocateFen([100, 100], 3, 0);
  console.log(`分摊示例：实付 3 分、两人原始小计相同，发起人承担余数后是 ${sample[0]} 分和 ${sample[1]} 分。`);

  const confirmed = await group.onCard(groupClick("group.confirm", owner));
  if (!confirmed.card || !confirmed.direct) throw new Error("演练确认没有分开群卡片和私聊");
  if (cardHasPaymentLink(confirmed.card)) throw new Error("群卡片出现了付款链接");
  console.log("\n步骤 8  发起人确认（DRY_RUN=true）。群卡片没有付款链接。");
  console.log(renderCardText(confirmed.card));
  console.log("\n发起人私聊：");
  console.log(renderCardText(confirmed.direct.card));
  if (count(mcp, "create-order") !== 0) throw new Error("演练模式调用了 create-order");
  console.log("\n本机台账（演示，不写多维表格）：");
  for (const row of ledger.rows) {
    console.log(`- ${row.participantName} ${row.itemsText} 应摊 ${row.shareYuan} 元，订单号 ${row.orderTail}，${row.payStatus}`);
  }
  const ledgerJson = JSON.stringify(ledger.rows);
  if (/1[3-9]\d{9}/.test(ledgerJson) || ledgerJson.includes("取餐码") || ledgerJson.includes("payH5Url")) {
    throw new Error("台账里出现了不该保存的字段");
  }

  const capped = new GroupFlow(mcp, state, new MemoryLedger(), orders, {
    ownerOpenId: owner,
    now: () => Date.parse("2026-10-19T12:00:00+08:00"),
  });
  await capped.onMessage({
    eventId: "group-cap",
    openId: owner,
    chatId: "group-cap",
    chatType: "group",
    text: "/麦麦 拼单 午饭 12:30",
  });
  for (let index = 0; index < 10; index += 1) {
    const added = await capped.onCard(groupClick("group.tick", owner, { productCode: "1440", delta: 1, sessionId: "g-group-cap" }));
    if (added.toast?.type === "warning") throw new Error("前 10 份不该被拒绝");
  }
  const blocked = await capped.onCard(groupClick("group.tick", "member-a", { productCode: "1440", delta: 1, sessionId: "g-group-cap", operatorName: "小王" }));
  if (!blocked.toast?.content.includes("10")) throw new Error("第 11 份没有被拦住");
  console.log(`\n步骤 9  第 11 份被拒绝：${blocked.toast?.content}`);
}

function groupClick(
  action: string,
  openId: string,
  extra: Partial<CardInput> & { sessionId?: string } = {},
): CardInput {
  return {
    eventId: `${action}-${openId}-${extra.delta ?? "x"}-${extra.productCode ?? "none"}`,
    operatorOpenId: openId,
    action,
    sessionId: extra.sessionId ?? "g-group-msg-1",
    form: {},
    ...extra,
  };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
