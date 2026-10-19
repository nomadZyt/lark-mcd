import { describe, expect, it } from "vitest";
import { explainMcpFailure, parseMealsPayload, parseMcpPayload, parseMcpText, readFrequentCode } from "../src/core/parse.js";

describe("MCP 响应解析", () => {
  it("从 Markdown 提示后面抽出 JSON", () => {
    const text = [
      "# API Response",
      "字段说明",
      "",
      '{"success":true,"code":200,"message":"请求成功","traceId":"demo","data":{"price":4400}}',
      "",
    ].join("\n");
    const parsed = parseMcpText(text);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ price: 4400 });
  });

  it("识别 success=false 的业务码", () => {
    const parsed = parseMcpPayload({
      result: {
        content: [
          {
            type: "text",
            text: '提示\n{"success":false,"code":60006,"message":"商品已售罄或不可售","traceId":"t1"}',
          },
        ],
      },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.code).toBe(60006);
    expect(explainMcpFailure(parsed)).toContain("换一个");
  });

  it("只有 Markdown 的工具也能接住", () => {
    const parsed = parseMcpText("### 活动列表\n- 早餐两件套");
    expect(parsed.markdown).toContain("活动列表");
    expect(parsed.success).toBe(true);
  });

  it("frequent 对象和数组都能读", () => {
    expect(readFrequentCode({ code: "1440", tags: ["我的常点"] })).toBe("1440");
    expect(readFrequentCode([{ code: "5022", tags: [] }])).toBe("5022");
    const parsed = parseMealsPayload({
      frequent: { code: "1440", tags: ["我的常点"] },
      meals: {
        "9900008094": {
          name: "吉士蛋麦满分组合",
          currentPrice: "7.2",
          originalPrice: "12",
          discountType: "随单购早餐卡优惠",
          canWithOrder: true,
          withOrder: { cardId: "CRD-DEMO", cardType: 2, specId: "SPEC-DEMO" },
        },
      },
    });
    expect(parsed.frequentCode).toBe("1440");
    expect(parsed.meals[0]?.withOrder).toEqual({
      cardId: "CRD-DEMO",
      cardType: 2,
      membershipSpecId: "SPEC-DEMO",
    });
  });

  it("样例形态 content[0].json 也能解析", () => {
    const parsed = parseMcpPayload({
      content: [{ json: { success: false, code: 600050, message: "收藏餐厅列表为空" } }],
    });
    expect(explainMcpFailure(parsed)).toContain("/麦麦 门店");
  });
});
