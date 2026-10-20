import { describe, expect, it } from "vitest";
import { loadFixtures } from "../src/core/mock-mcp.js";
import {
  GROUP_PORTION_CAP,
  aggregateItems,
  applyTick,
  parseGroupCommand,
  pickCandidates,
  totalPortions,
  type GroupVote,
} from "../src/core/group-vote.js";

function vote(): GroupVote {
  return {
    id: "g-1",
    chatId: "c",
    ownerOpenId: "owner",
    storeCode: "DEMO-A",
    storeName: "演示门店 A",
    scene: "午餐",
    slot: "12:00",
    candidates: [
      { productCode: "1440", name: "麦辣鸡腿汉堡", referenceFen: 2250 },
      { productCode: "1700", name: "麦辣鸡翅", referenceFen: 1500 },
    ],
    lines: [],
    status: "open",
  };
}

describe("群投票", () => {
  it("汇总每人份数，超过 10 份就拒绝，门店和时段不变", () => {
    let current = vote();
    for (let count = 0; count < GROUP_PORTION_CAP; count += 1) {
      const openId = `m${count}`;
      const next = applyTick(current, { openId, displayName: openId, productCode: "1440", delta: 1 });
      expect(next.ok).toBe(true);
      if (next.ok) current = { ...current, lines: next.lines };
    }
    expect(totalPortions(current.lines)).toBe(10);
    const blocked = applyTick(current, { openId: "extra", displayName: "extra", productCode: "1440", delta: 1 });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain("10");
    expect(current.storeCode).toBe("DEMO-A");
    expect(current.slot).toBe("12:00");
    expect(aggregateItems(current)).toEqual([{ productCode: "1440", quantity: 10, name: "麦辣鸡腿汉堡" }]);
  });

  it("候选去掉随单购，参考价用现价", () => {
    const candidates = pickCandidates(loadFixtures().meals);
    expect(candidates.length).toBeGreaterThanOrEqual(6);
    expect(candidates.length).toBeLessThanOrEqual(8);
    expect(candidates.map((item) => item.name)).not.toContain("麦辣鸡腿堡四件套");
    expect(candidates.find((item) => item.productCode === "1440")?.referenceFen).toBe(2250);
  });

  it("解析拼单指令", () => {
    expect(parseGroupCommand("/麦麦 拼单 午饭 12:00")).toEqual({ type: "start", scene: "午餐", slot: "12:00" });
    expect(parseGroupCommand("/麦麦 拼单 加班餐 18:30")).toEqual({ type: "start", scene: "加班餐", slot: "18:30" });
    expect(parseGroupCommand("/麦麦 拼单 9:05")).toEqual({ type: "start", scene: "午餐", slot: "09:05" });
    expect(parseGroupCommand("/麦麦 拼单")).toEqual({ type: "incomplete" });
    expect(parseGroupCommand("老样子")).toBeUndefined();
  });
});
