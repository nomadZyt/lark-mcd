import { describe, expect, it } from "vitest";
import { computePayback, frequencyFromOrders } from "../src/core/payback.js";

const forbidden = ["别买", "智商税", "不划算", "坑爹", "肯德基", "汉堡王", "德克士", "华莱士", "必胜客", "暴食", "狂吃", "熬夜加餐"];

function base(over: Partial<Parameters<typeof computePayback>[0]> = {}) {
  return computePayback({
    saveFen: 2900,
    cardPriceFen: 1990,
    weeklyFrequency: 3,
    orderSampleSize: 1,
    eligibleCount: 1,
    saveSource: "quote",
    cardPriceSource: "manual",
    frequencySource: "manual",
    cardLabel: "麦金卡",
    ...over,
  });
}

describe("会员卡小算盘", () => {
  it("按卡价、节省和频率算出次数和天数", () => {
    const result = base();
    expect(result.kind).toBe("ready");
    expect(result.repeats).toBe(1);
    expect(result.days).toBe(3);
    expect(result.lines.join("\n")).toContain("大约 1 次（约 3 天）回本");
    const other = base({ saveFen: 100, cardPriceFen: 250, weeklyFrequency: 2 });
    expect(other.repeats).toBe(3);
    expect(other.days).toBe(11);
  });

  it("省不下来时不写回本", () => {
    const result = base({ saveFen: 0 });
    expect(result.kind).toBe("no-discount");
    expect(result.lines.join("\n")).toContain("本单没有随单购优惠");
    expect(result.lines.join("\n")).not.toContain("回本");
  });

  it("订单不足 3 笔时请用户自己选频率", () => {
    expect(frequencyFromOrders([{ createTime: "2026-04-30 17:59:20" }])).toBeNull();
    const result = base({ weeklyFrequency: null, orderSampleSize: 1, frequencySource: "unknown" });
    expect(result.kind).toBe("need-input");
    expect(result.lines.join("\n")).toContain("不足 3 笔");
    expect(result.repeats).toBe(1);
    expect(result.days).toBeNull();
  });

  it("文案不含贬低或比较", () => {
    const texts = [
      base().lines.join("\n"),
      base({ saveFen: 0 }).lines.join("\n"),
      base({ cardPriceFen: null }).lines.join("\n"),
      base({ weeklyFrequency: null }).lines.join("\n"),
    ];
    for (const text of texts) {
      for (const word of forbidden) expect(text).not.toContain(word);
    }
    expect(texts[0]).toContain("不会替你购买会员卡");
  });
});
