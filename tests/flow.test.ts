import { describe, expect, it } from "vitest";
import { collectCardText } from "../src/cards/build.js";
import { HELP_TEXT, parseCommand } from "../src/bot/flow.js";
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

describe("parseCommand", () => {
  it("识别菜单和点餐", () => {
    expect(parseCommand("/麦麦 菜单")).toEqual({ type: "menu" });
    expect(parseCommand("/麦麦 点")).toEqual({ type: "menu" });
    expect(parseCommand("/麦麦  点  麦辣鸡腿汉堡")).toEqual({ type: "point", query: "麦辣鸡腿汉堡" });
    expect(parseCommand("/麦麦 点 麦辣鸡腿汉堡 麦辣鸡翅")).toEqual({
      type: "point",
      query: "麦辣鸡腿汉堡 麦辣鸡翅",
    });
    expect(parseCommand("老样子")).toEqual({ type: "old-usual" });
    expect(parseCommand("/麦麦 门店 上海 人民广场")).toEqual({ type: "store", city: "上海", keyword: "人民广场" });
    expect(HELP_TEXT).toContain("/麦麦 菜单");
    expect(HELP_TEXT).toContain("/麦麦 点 餐品名");
  });
});

describe("菜单和点餐", () => {
  it("菜单点选后走原来的核价确认卡片", async () => {
    const { flow, mcp } = setup();
    const menu = await flow.onMessage(message({ text: "/麦麦 菜单", eventId: "menu-1" }));
    const menuText = collectCardText(menu.card!);
    expect(menuText).toContain("现在卖这些");
    expect(menuText).toContain("麦辣鸡腿汉堡");
    expect(menuText).toContain("就这个");
    expect(JSON.stringify(menu.card)).toContain('"a":"menu.pick"');
    expect(calls(mcp, "query-meals")).toBe(1);
    expect(calls(mcp, "calculate-price")).toBe(0);

    const picked = await flow.onCard(
      card({
        action: "menu.pick",
        eventId: "pick-meal",
        sessionId: undefined,
        productCode: "1440",
      }),
    );
    const priced = collectCardText(picked.card!);
    expect(priced).toContain("麦辣鸡腿汉堡");
    expect(priced).toContain("确认下单");
    expect(calls(mcp, "calculate-price")).toBe(1);
    expect(calls(mcp, "create-order")).toBe(0);

    const confirmed = await flow.onCard(
      card({ action: "order.confirm", eventId: "confirm-menu", sessionId: "d-pick-meal" }),
    );
    expect(collectCardText(confirmed.card!)).toContain("没有向麦当劳下单");
    expect(calls(mcp, "create-order")).toBe(0);
  });

  it("点到唯一餐品时直接核价", async () => {
    const { flow, mcp } = setup();
    const result = await flow.onMessage(message({ text: "/麦麦 点 猪柳蛋麦满分", eventId: "point-1" }));
    const text = collectCardText(result.card!);
    expect(text).toContain("猪柳蛋麦满分");
    expect(text).toContain("确认下单");
    expect(calls(mcp, "query-meals")).toBe(1);
    expect(calls(mcp, "calculate-price")).toBe(1);
    const price = mcp.calls.find((call) => call.tool === "calculate-price");
    expect(price?.args.items).toEqual([{ productCode: "5022", quantity: 1 }]);
    expect(calls(mcp, "create-order")).toBe(0);
  });

  it("名字对上好几份时给出可选列表，不核价", async () => {
    const { flow, mcp } = setup();
    const result = await flow.onMessage(message({ text: "/麦麦 点 麦辣", eventId: "point-many" }));
    const text = collectCardText(result.card!);
    expect(text).toContain("对上了好几份");
    expect(text).toContain("麦辣鸡腿汉堡");
    expect(text).toContain("麦辣鸡翅");
    expect(text).not.toContain("阳光橙");
    expect(calls(mcp, "calculate-price")).toBe(0);
    expect(calls(mcp, "query-meals")).toBe(1);
  });

  it("没有匹配时改发当前菜单", async () => {
    const { flow, mcp } = setup();
    const result = await flow.onMessage(message({ text: "/麦麦 点 巨无霸", eventId: "point-none" }));
    const text = collectCardText(result.card!);
    expect(text).toContain("没有找到「巨无霸」");
    expect(text).toContain("麦辣鸡腿汉堡");
    expect(text).toContain("阳光橙");
    expect(calls(mcp, "calculate-price")).toBe(0);
  });

  it("老样子核价 60006 时改发菜单，而不是只回一句话", async () => {
    const saved = loadDemoState();
    saved.favorite = {
      savedAt: "2026-10-21T08:00:00.000Z",
      items: [{ productCode: "NOT-IN-DAYPART", quantity: 1, name: "早餐板烧" }],
    };
    const { flow, mcp } = setup({ state: saved });
    const result = await flow.onMessage(message({ eventId: "usual-60006" }));
    const text = collectCardText(result.card!);
    expect(text).toContain("这个时段买不到");
    expect(text).toContain("换一个");
    expect(text).toContain("麦辣鸡腿汉堡");
    expect(text).toContain("就这个");
    expect(result.text).toBeUndefined();
    expect(calls(mcp, "calculate-price")).toBe(1);
    expect(calls(mcp, "query-meals")).toBe(1);
    expect(calls(mcp, "create-order")).toBe(0);
  });

  it("最近一单在当前时段买不到时也改发菜单", async () => {
    const saved = loadDemoState();
    delete saved.favorite;
    const { flow, mcp } = setup({ state: saved });
    const base = mcp.fixtures.orders[0];
    expect(base).toBeTruthy();
    mcp.fixtures.orders = [
      {
        ...base!,
        orderProductList: [
          {
            productCode: "BREAKFAST-ONLY",
            productName: "板烧鸡腿麦满分",
            quantity: 1,
            comboItemList: [],
          },
        ],
      },
    ];
    const result = await flow.onMessage(message({ eventId: "history-60006" }));
    const text = collectCardText(result.card!);
    expect(text).toContain("这个时段买不到");
    expect(text).toContain("猪柳蛋麦满分");
    expect(calls(mcp, "order-list")).toBe(1);
    expect(calls(mcp, "calculate-price")).toBe(1);
    expect(calls(mcp, "query-meals")).toBe(1);
    expect(calls(mcp, "create-order")).toBe(0);
  });

  it("点餐核价 60006 时用刚拉到的菜单回退，不再查一次", async () => {
    const { flow, mcp } = setup();
    mcp.unavailableCodes.add("1440");
    const result = await flow.onMessage(message({ text: "/麦麦 点 麦辣鸡腿汉堡", eventId: "point-60006" }));
    const text = collectCardText(result.card!);
    expect(text).toContain("这个时段买不到");
    expect(text).toContain("猪柳蛋麦满分");
    expect(text).not.toContain("参考价 ¥22.5");
    expect(calls(mcp, "query-meals")).toBe(1);
    expect(calls(mcp, "calculate-price")).toBe(1);
    expect(calls(mcp, "create-order")).toBe(0);
  });

  it("没设门店或不是主人时菜单不调用 MCP", async () => {
    const saved = loadDemoState();
    delete saved.store;
    const missing = setup({ state: saved });
    const hint = await missing.flow.onMessage(message({ text: "/麦麦 菜单", eventId: "no-store" }));
    expect(hint.text).toContain("/麦麦 门店");
    expect(missing.mcp.calls).toHaveLength(0);

    const { flow, mcp } = setup();
    const denied = await flow.onMessage(message({ text: "/麦麦 点 汉堡", openId: "other", eventId: "other" }));
    expect(denied.text).toContain("只有发起人");
    expect(mcp.calls).toHaveLength(0);
  });
});
