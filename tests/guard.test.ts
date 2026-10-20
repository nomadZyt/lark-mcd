import { describe, expect, it } from "vitest";
import { GuardError, McpGuard } from "../src/core/guard.js";
import type { Trigger } from "../src/core/types.js";

function trigger(over: Partial<Trigger> = {}): Trigger {
  return {
    kind: "card",
    eventId: "evt-1",
    operatorOpenId: "owner",
    action: "confirm",
    ...over,
  };
}

describe("MCP guard", () => {
  it("没有触发者就不发请求", () => {
    const guard = new McpGuard({ ownerOpenId: "owner", dryRun: true });
    expect(() => guard.begin("calculate-price", undefined)).toThrow(GuardError);
    expect(() => guard.begin("calculate-price", undefined)).toThrow(/缺少用户触发/);
  });

  it("不是 Token 主人就拒绝", () => {
    const guard = new McpGuard({ ownerOpenId: "owner", dryRun: true });
    expect(() => guard.begin("calculate-price", trigger({ operatorOpenId: "someone-else", action: "old-usual", kind: "message" }))).toThrow(
      /只有发起人/,
    );
  });

  it("同一次点击不能超过动作预算", () => {
    const guard = new McpGuard({ ownerOpenId: "owner", dryRun: true });
    const click = trigger({ action: "confirm" });
    guard.begin("query-order", trigger({ action: "refresh", eventId: "other" }), { orderId: "o1", now: 0 });
    guard.begin("calculate-price", click);
    expect(() => guard.begin("calculate-price", click)).toThrow(/上限/);
  });

  it("演练模式拦截写操作", () => {
    const guard = new McpGuard({ ownerOpenId: "owner", dryRun: true });
    expect(() =>
      guard.begin("create-order", trigger(), { draftId: "d1", draftStatus: "priced" }),
    ).toThrow(/演练模式/);
    expect(() => guard.begin("cancel-order", trigger({ action: "cancel" }), { orderId: "o1" })).toThrow(/演练模式/);
  });

  it("显式 DRY_RUN=false 才允许写，而且同一草稿只下一次", () => {
    const guard = new McpGuard({ ownerOpenId: "owner", dryRun: false });
    const first = guard.begin("create-order", trigger({ eventId: "a" }), { draftId: "d1", draftStatus: "priced" });
    guard.finish(first, true);
    expect(() => guard.begin("create-order", trigger({ eventId: "b" }), { draftId: "d1", draftStatus: "priced" })).toThrow(
      /已经完成/,
    );
  });

  it("群截止的动作不能直接下单", () => {
    const guard = new McpGuard({ ownerOpenId: "owner", dryRun: false });
    expect(() =>
      guard.begin("create-order", trigger({ action: "group.close", eventId: "group-close" }), {
        draftId: "d1",
        draftStatus: "priced",
      }),
    ).toThrow(/确认下单/);
  });

  it("写操作必须来自卡片，草稿要处于已核价", () => {
    const guard = new McpGuard({ ownerOpenId: "owner", dryRun: false });
    expect(() =>
      guard.begin("create-order", trigger({ kind: "message", action: "confirm" }), { draftId: "d1", draftStatus: "priced" }),
    ).toThrow(/卡片点击/);
    expect(() =>
      guard.begin("create-order", trigger(), { draftId: "d1", draftStatus: "ordered" }),
    ).toThrow(/已核价/);
  });

  it("领券、抽奖这些写工具直接拒绝", () => {
    const guard = new McpGuard({ ownerOpenId: "owner", dryRun: false });
    for (const tool of ["auto-bind-coupons", "draw-lottery", "mall-create-order", "party-order-create", "delivery-create-address"]) {
      expect(() => guard.begin(tool, trigger({ action: "old-usual", kind: "message" }))).toThrow(/白名单/);
    }
  });

  it("Agent 来源不能下单或取消，错误码是 TOOL_DISABLED", () => {
    for (const dryRun of [true, false]) {
      const guard = new McpGuard({ ownerOpenId: "owner", dryRun });
      const agent = trigger({ kind: "agent", action: "agent.quote", eventId: `agent-${dryRun}` });
      expect(() => guard.begin("create-order", agent, { draftId: "d1", draftStatus: "priced" })).toThrow(GuardError);
      try {
        guard.begin("create-order", { ...agent, eventId: `create-${dryRun}` }, { draftId: "d1", draftStatus: "priced" });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(GuardError);
        expect((error as GuardError).code).toBe("TOOL_DISABLED");
        expect((error as GuardError).message).not.toMatch(/演练/);
      }
      try {
        guard.begin("cancel-order", { ...agent, action: "agent.status", eventId: `cancel-${dryRun}` }, { orderId: "o1" });
        expect.unreachable();
      } catch (error) {
        expect((error as GuardError).code).toBe("TOOL_DISABLED");
      }
    }
  });

  it("Agent 来源可以核价", () => {
    const guard = new McpGuard({ ownerOpenId: "owner", dryRun: true });
    expect(() =>
      guard.begin("calculate-price", trigger({ kind: "agent", action: "agent.quote", eventId: "quote-1" })),
    ).not.toThrow();
  });

  it("同一订单 10 秒内只能刷新一次", () => {
    const guard = new McpGuard({ ownerOpenId: "owner", dryRun: true });
    guard.begin("query-order", trigger({ action: "refresh", eventId: "r1" }), { orderId: "order-1", now: 10_000 });
    expect(() =>
      guard.begin("query-order", trigger({ action: "refresh", eventId: "r2" }), { orderId: "order-1", now: 15_000 }),
    ).toThrow(/再刷新/);
    expect(() =>
      guard.begin("query-order", trigger({ action: "refresh", eventId: "r3" }), { orderId: "order-1", now: 20_000 }),
    ).not.toThrow();
  });
});
