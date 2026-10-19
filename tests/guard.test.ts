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
