import { describe, expect, it } from "vitest";
import { cardHasPaymentLink, collectCardText } from "../src/cards/build.js";
import type { CardInput } from "../src/bot/flow.js";
import { calls, setupGroup } from "./helpers.js";

function click(over: Partial<CardInput> = {}): CardInput {
  return {
    eventId: over.eventId ?? `e-${over.action ?? "group.tick"}-${over.operatorOpenId ?? "owner"}`,
    operatorOpenId: over.operatorOpenId ?? "owner",
    action: over.action ?? "group.tick",
    sessionId: "g-msg-1",
    form: {},
    ...over,
  };
}

describe("群拼单流程", () => {
  it("成员多次勾选不调用 MCP，非主人不能核价或下单", async () => {
    const { group, mcp } = setupGroup();
    await group.onMessage({
      eventId: "msg-1",
      openId: "owner",
      chatId: "room",
      chatType: "group",
      text: "/麦麦 拼单 午饭 12:00",
    });
    expect(calls(mcp, "query-meals")).toBe(1);
    const before = mcp.calls.length;
    for (let member = 0; member < 9; member += 1) {
      const openId = `m${member}`;
      await group.onCard(click({ operatorOpenId: openId, operatorName: `成员${member}`, productCode: "1440", delta: 1, eventId: `a-${member}` }));
      await group.onCard(click({ operatorOpenId: openId, operatorName: `成员${member}`, productCode: "1440", delta: 1, eventId: `b-${member}` }));
      await group.onCard(click({ operatorOpenId: openId, operatorName: `成员${member}`, productCode: "1440", delta: -1, eventId: `c-${member}` }));
    }
    expect(mcp.calls.length).toBe(before);
    const close = await group.onCard(click({ action: "group.close", operatorOpenId: "m0", eventId: "close-other" }));
    const confirm = await group.onCard(click({ action: "group.confirm", operatorOpenId: "m1", eventId: "confirm-other" }));
    expect(close.toast?.content).toContain("只有发起人");
    expect(confirm.toast?.content).toContain("只有发起人");
    expect(calls(mcp, "calculate-price")).toBe(0);
    expect(calls(mcp, "create-order")).toBe(0);
    expect(mcp.calls.length).toBe(before);
  });

  it("一场只有一家店一个时段，第 11 份被拒绝", async () => {
    const { group, mcp } = setupGroup();
    const first = await group.onMessage({
      eventId: "msg-1",
      openId: "owner",
      chatId: "room",
      chatType: "group",
      text: "/麦麦 拼单 团队活动 18:00",
    });
    expect(collectCardText(first.card!)).toContain("18:00");
    expect(collectCardText(first.card!)).toContain("演示门店 A");
    expect(collectCardText(first.card!)).not.toContain("麦辣鸡腿堡四件套");
    const second = await group.onMessage({
      eventId: "msg-2",
      openId: "owner",
      chatId: "room",
      chatType: "group",
      text: "/麦麦 拼单 午饭 12:00",
    });
    expect(second.text).toContain("一家店");
    expect(calls(mcp, "query-meals")).toBe(1);
    const stranger = await group.onMessage({
      eventId: "msg-3",
      openId: "other",
      chatId: "room-2",
      chatType: "group",
      text: "/麦麦 拼单 午饭 12:00",
    });
    expect(stranger.text).toContain("只有发起人");
    expect(calls(mcp, "query-meals")).toBe(1);
    for (let index = 0; index < 10; index += 1) {
      const added = await group.onCard(
        click({ operatorOpenId: `p${index}`, productCode: "5022", delta: 1, eventId: `add-${index}` }),
      );
      expect(added.card).toBeTruthy();
    }
    const blocked = await group.onCard(click({ operatorOpenId: "overflow", productCode: "5022", delta: 1, eventId: "add-11" }));
    expect(blocked.toast?.content).toContain("10");
    expect(calls(mcp, "calculate-price")).toBe(0);
  });

  it("演练确认把明细只发给发起人，台账不落完整订单号", async () => {
    const { group, mcp, ledger } = setupGroup({ dryRun: true });
    await openAndFill(group);
    const priced = await group.onCard(click({ action: "group.close", eventId: "close" }));
    expect(collectCardText(priced.card!)).toContain("每人应摊");
    expect(calls(mcp, "calculate-price")).toBe(1);
    const confirmed = await group.onCard(click({ action: "group.confirm", eventId: "confirm" }));
    expect(confirmed.card).toBeTruthy();
    expect(confirmed.direct?.openId).toBe("owner");
    expect(cardHasPaymentLink(confirmed.card!)).toBe(false);
    expect(JSON.stringify(confirmed.card)).not.toContain("open_url");
    expect(collectCardText(confirmed.direct!.card)).toContain("没有向麦当劳下单");
    expect(calls(mcp, "create-order")).toBe(0);
    expect(ledger.rows.length).toBeGreaterThan(0);
    expect(ledger.rows.every((row) => row.orderTail === "演练")).toBe(true);
    const written = ledger.rows.length;
    const again = await group.onCard(click({ action: "group.confirm", eventId: "confirm-2" }));
    expect(cardHasPaymentLink(again.card!)).toBe(false);
    expect(ledger.rows).toHaveLength(written);
    expect(calls(mcp, "create-order")).toBe(0);
  });

  it("真实下单时付款链接只在私聊，分摊之和等于实付，刷新不把取餐码写入台账", async () => {
    const { group, mcp, ledger } = setupGroup({ dryRun: false });
    await openAndFill(group);
    await group.onCard(click({ action: "group.close", eventId: "close" }));
    const confirmed = await group.onCard(click({ action: "group.confirm", eventId: "confirm" }));
    expect(calls(mcp, "create-order")).toBe(1);
    const create = mcp.calls.find((call) => call.tool === "create-order");
    expect(create?.args).not.toHaveProperty("withOrder");
    expect(create?.args).not.toHaveProperty("beCode");
    expect(cardHasPaymentLink(confirmed.card!)).toBe(false);
    expect(JSON.stringify(confirmed.card)).not.toContain("DEMO202610190001");
    expect(cardHasPaymentLink(confirmed.direct!.card)).toBe(true);
    expect(confirmed.direct?.openId).toBe("owner");
    const again = await group.onCard(click({ action: "group.confirm", eventId: "confirm-2" }));
    expect(calls(mcp, "create-order")).toBe(1);
    expect(cardHasPaymentLink(again.card!)).toBe(false);
    const json = JSON.stringify(ledger.rows);
    expect(json).not.toContain("DEMO202610190001");
    expect(json).not.toContain("8821");
    expect(json).not.toContain("example.invalid");
    expect(ledger.rows[0]?.orderTail).toBe("0001");
    const fen = ledger.rows.map((row) => Math.round(row.shareYuan * 100));
    expect(fen.reduce((sum, item) => sum + item, 0)).toBe(Math.round(ledger.rows[0]!.orderTotalYuan * 100));
    const refreshed = await group.onCard(
      click({ action: "group.refresh", eventId: "refresh", messageId: "om_group" }),
    );
    expect(calls(mcp, "query-order")).toBe(1);
    expect(collectCardText(refreshed.card!)).toContain("8821");
    expect(cardHasPaymentLink(refreshed.card!)).toBe(false);
    expect(JSON.stringify(ledger.rows)).not.toContain("8821");
    expect(ledger.rows.every((row) => row.payStatus.includes("已支付"))).toBe(true);
    expect(refreshed.direct?.openId).toBe("owner");
  });
});

async function openAndFill(group: ReturnType<typeof setupGroup>["group"]): Promise<void> {
  await group.onMessage({
    eventId: "msg-1",
    openId: "owner",
    chatId: "room",
    chatType: "group",
    text: "/麦麦 拼单 午饭 12:00",
  });
  await group.onCard(click({ operatorOpenId: "member-a", operatorName: "小王", productCode: "1440", delta: 1, eventId: "t1" }));
  await group.onCard(click({ operatorOpenId: "member-b", operatorName: "小李", productCode: "1700", delta: 1, eventId: "t2" }));
}
