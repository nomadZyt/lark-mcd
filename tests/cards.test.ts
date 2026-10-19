import { describe, expect, it } from "vitest";
import { buildCard, collectCardText } from "../src/cards/build.js";
import { renderCardText } from "../src/cards/render.js";
import type { CardModel } from "../src/cards/types.js";

const forbidden = ["别买", "智商税", "不划算", "坑爹", "肯德基", "汉堡王", "暴食", "狂吃"];

const priced: CardModel = {
  kind: "priced",
  storeName: "演示门店 A",
  lines: [
    { name: "麦辣鸡腿汉堡", quantity: 2, subtotalFen: 4500 },
    { name: "麦辣鸡腿堡四件套", quantity: 1, subtotalFen: 5700 },
  ],
  totalFen: 10200,
  discountFen: 0,
  tablewareFen: 0,
  takeWays: [
    { code: "eat-in", title: "堂食" },
    { code: "locker-out", title: "外带" },
  ],
  selectedTakeWay: "eat-in",
  needTableware: false,
  sessionId: "d-1",
  comboDefault: true,
  eligibleCount: 1,
  paybackLines: null,
};

describe("卡片", () => {
  it("核价卡片带确认回调，不放价格明细到回传值里", () => {
    const card = buildCard(priced);
    expect(card.schema).toBe("2.0");
    expect(card.config.update_multi).toBe(true);
    const json = JSON.stringify(card);
    expect(json).toContain('"a":"order.confirm"');
    expect(json).toContain('"sid":"d-1"');
    expect(json).toContain('"v":1');
    expect(json).not.toContain("10200");
    expect(collectCardText(card)).toContain("¥102.0");
    expect(collectCardText(card)).toContain("套餐按默认搭配");
    expect(collectCardText(card)).toContain("不会替你购买会员卡");
    expect(renderCardText(card)).toContain("确认下单");
    for (const word of forbidden) expect(collectCardText(card)).not.toContain(word);
  });

  it("付款按钮只打开链接，不走回调", () => {
    const card = buildCard({
      kind: "pay",
      sessionId: "d-1",
      orderTail: "…0001",
      totalFen: 10200,
      payH5Url: "https://example.invalid/lark-mcd/pay-demo",
    });
    const pay = card.body.elements.find((element) => {
      const text = (element.text as { content?: string } | undefined)?.content;
      return text === "去付款";
    });
    expect(pay?.behaviors).toEqual([
      { type: "open_url", default_url: "https://example.invalid/lark-mcd/pay-demo" },
    ]);
    expect(JSON.stringify(pay)).not.toContain("callback");
    expect(collectCardText(card)).toContain("不经手资金");
  });

  it("演练卡片说明没有下单", () => {
    const card = buildCard({
      kind: "dry-run",
      storeName: "演示门店 A",
      lines: priced.kind === "priced" ? priced.lines : [],
      totalFen: 10200,
      takeWayTitle: "堂食",
      sessionId: "d-1",
    });
    expect(collectCardText(card)).toContain("没有向麦当劳下单");
    expect(JSON.stringify(card)).not.toContain("open_url");
  });
});
