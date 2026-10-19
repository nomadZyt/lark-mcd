import { describe, expect, it } from "vitest";
import { collectCardText } from "../src/cards/build.js";
import { QUOTE_TTL_MS } from "../src/core/types.js";
import { loadDemoState } from "../src/bot/state.js";
import { calls, card, message, setup } from "./helpers.js";

describe("私聊老样子", () => {
  it("有本地配方时只核价一次", async () => {
    const { flow, mcp } = setup();
    const result = await flow.onMessage(message());
    expect(result.card).toBeTruthy();
    expect(collectCardText(result.card!)).toContain("麦辣鸡腿汉堡");
    expect(collectCardText(result.card!)).toContain("会员卡小算盘");
    expect(calls(mcp, "calculate-price")).toBe(1);
    expect(calls(mcp, "order-list")).toBe(0);
    expect(calls(mcp, "create-order")).toBe(0);
  });

  it("没有配方时用最近一笔已完成订单", async () => {
    const saved = loadDemoState();
    delete saved.favorite;
    const { flow, mcp } = setup({ state: saved });
    const result = await flow.onMessage(message());
    expect(collectCardText(result.card!)).toContain("BFF四宫格小食盘");
    expect(calls(mcp, "order-list")).toBe(1);
    expect(calls(mcp, "calculate-price")).toBe(1);
  });

  it("演练模式确认下单不会调用 create-order", async () => {
    const { flow, mcp } = setup({ dryRun: true });
    await flow.onMessage(message());
    const result = await flow.onCard(card());
    expect(collectCardText(result.card!)).toContain("没有向麦当劳下单");
    expect(calls(mcp, "create-order")).toBe(0);
  });

  it("关闭演练后同一草稿连点只下一次单，并且不带随单购", async () => {
    const { flow, mcp } = setup({ dryRun: false });
    await flow.onMessage(message());
    const clicks = [1, 2, 3, 4, 5].map((index) =>
      flow.onCard(card({ eventId: `confirm-${index}` })),
    );
    await Promise.all(clicks);
    expect(calls(mcp, "create-order")).toBe(1);
    const create = mcp.calls.find((call) => call.tool === "create-order");
    expect(create?.args).not.toHaveProperty("withOrder");
    expect(create?.args).toMatchObject({ orderType: 1, beType: 1, storeCode: "DEMO-A" });
    expect(create?.args).not.toHaveProperty("beCode");
    await flow.onCard(card({ eventId: "confirm-again" }));
    expect(calls(mcp, "create-order")).toBe(1);
  });

  it("非发起人和群消息都不会调用 MCP", async () => {
    const { flow, mcp } = setup();
    await flow.onMessage(message({ openId: "other", eventId: "m2" }));
    await flow.onMessage(message({ chatType: "group", eventId: "m3" }));
    await flow.onMessage(message());
    await flow.onCard(card({ operatorOpenId: "other", eventId: "c2" }));
    expect(calls(mcp, "calculate-price")).toBe(1);
    expect(mcp.calls.every((call) => call.tool === "calculate-price")).toBe(true);
  });

  it("小算盘按填写的卡价和频率给出天数，并且不买卡", async () => {
    const { flow, mcp } = setup();
    await flow.onMessage(message());
    const result = await flow.onCard(
      card({
        action: "payback.calc",
        eventId: "payback-1",
        form: { card_price: "19.9", freq: "3" },
      }),
    );
    const text = collectCardText(result.card!);
    expect(text).toContain("可省 ¥29.0");
    expect(text).toContain("大约 1 次（约 3 天）回本");
    expect(text).toContain("不会替你购买会员卡");
    expect(calls(mcp, "create-order")).toBe(0);
    const second = mcp.calls.find((call) => call.tool === "calculate-price" && "withOrder" in call.args);
    expect(second?.args.withOrder).toMatchObject({ membershipSpecId: "SPEC-DEMO" });
  });

  it("刷新有 10 秒冷却", async () => {
    let now = Date.parse("2026-10-19T12:00:00+08:00");
    const { flow, mcp } = setup({ dryRun: false, now: () => now });
    await flow.onMessage(message());
    await flow.onCard(card({ eventId: "confirm" }));
    await flow.onCard(card({ action: "order.refresh", eventId: "refresh-1" }));
    now += 1000;
    await flow.onCard(card({ action: "order.refresh", eventId: "refresh-2" }));
    expect(calls(mcp, "query-order")).toBe(1);
    now += 10_000;
    const refreshed = await flow.onCard(card({ action: "order.refresh", eventId: "refresh-3" }));
    expect(calls(mcp, "query-order")).toBe(2);
    expect(collectCardText(refreshed.card!)).toContain("8821");
  });

  it("核价过期后确认不会下单", async () => {
    let now = Date.parse("2026-10-19T12:00:00+08:00");
    const { flow, mcp } = setup({ dryRun: false, now: () => now });
    await flow.onMessage(message());
    now += QUOTE_TTL_MS + 1;
    const result = await flow.onCard(card({ eventId: "late" }));
    expect(collectCardText(result.card!)).toContain("重新核价");
    expect(calls(mcp, "create-order")).toBe(0);
  });

  it("选店点击不再调用 MCP", async () => {
    const saved = loadDemoState();
    delete saved.store;
    delete saved.favorite;
    const { flow, mcp, state } = setup({ state: saved });
    const found = await flow.onMessage(message({ text: "/麦麦 门店 演示市 演示广场", eventId: "store-1" }));
    expect(collectCardText(found.card!)).toContain("演示门店 A");
    expect(calls(mcp, "query-nearby-stores")).toBe(1);
    const picked = await flow.onCard(
      card({
        action: "store.pick",
        eventId: "pick-1",
        sessionId: undefined,
        storeCode: "DEMO-A",
        storeName: "演示门店 A",
      }),
    );
    expect(calls(mcp, "query-nearby-stores")).toBe(1);
    expect(mcp.calls).toHaveLength(1);
    expect(picked.card).toBeTruthy();
    expect(state.load().store).toMatchObject({ storeCode: "DEMO-A", city: "演示市" });
  });

  it("演练模式取消不会调用 cancel-order", async () => {
    const { flow, mcp } = setup({ dryRun: false });
    await flow.onMessage(message());
    await flow.onCard(card({ eventId: "confirm" }));
    const { flow: dry, mcp: dryMcp } = setup({ dryRun: true });
    await dry.onMessage(message());
    await dry.onCard(card({ action: "order.cancel", eventId: "ask" }));
    const cancelled = await dry.onCard(card({ action: "order.cancel.confirm", eventId: "do" }));
    expect(collectCardText(cancelled.card!)).toContain("不会调用取消");
    expect(calls(dryMcp, "cancel-order")).toBe(0);
    expect(calls(mcp, "cancel-order")).toBe(0);
  });
});
