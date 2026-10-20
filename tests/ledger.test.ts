import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BitableLedger,
  FileRecordIndex,
  JsonLedger,
  LEDGER_FIELDS,
  bitableFields,
  buildLedgerRows,
  ledgerBody,
  ledgerRecordFromUnknown,
  type BitableClient,
} from "../src/bot/ledger.js";

const phone = "13800138000";
const address = "秘密路88号";
const pickup = "8821";
const fullOrder = "DEMO202610190009";

describe("报销台账", () => {
  it("丢掉手机号、地址、取餐码和完整订单号", () => {
    const record = ledgerRecordFromUnknown({
      datetime: "2026-10-19T12:00:00+08:00",
      storeName: "演示门店 A",
      orderId: fullOrder,
      scene: "午餐",
      headcount: 2,
      participantOpenId: "ou_member",
      participantName: "小王",
      itemsText: `麦辣鸡腿汉堡 × 1 取餐码 ${pickup} 电话${phone}`,
      shareYuan: 22.5,
      orderTotalYuan: 37.5,
      payStatus: "待支付",
      phone,
      mobile: phone,
      address,
      pickupCode: pickup,
      payH5Url: "https://example.invalid/pay",
    });
    const json = ledgerBody([record]);
    expect(json).not.toContain(phone);
    expect(json).not.toContain(address);
    expect(json).not.toContain(pickup);
    expect(json).not.toContain(fullOrder);
    expect(json).not.toContain("payH5Url");
    expect(json).not.toContain("https://");
    expect(record.orderTail).toBe("0009");
    expect(JSON.parse(json)[0]).not.toHaveProperty("phone");
    expect(JSON.parse(json)[0]).not.toHaveProperty("address");
    expect(JSON.parse(json)[0]).not.toHaveProperty("pickupCode");
    expect(JSON.parse(json)[0]).not.toHaveProperty("orderId");
  });

  it("没配多维表格时写本地 JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-mcd-ledger-"));
    const ledger = new JsonLedger(join(dir, "ledger.json"));
    const rows = buildLedgerRows({
      datetime: "2026-10-19T12:00:00+08:00",
      storeName: "演示门店 A",
      dryRun: true,
      scene: "午餐",
      shares: [
        {
          openId: "a",
          rawFen: 2250,
          shareFen: 2250,
          lines: [{ productCode: "1440", productName: "麦辣鸡腿汉堡", quantity: 1, subtotalFen: 2250 }],
        },
      ],
      names: new Map([["a", "小王"]]),
      orderFen: 2250,
      payStatus: "未下单",
    });
    const written = await ledger.write(rows);
    expect(written.destination).toBe("json");
    const saved = readFileSync(join(dir, "ledger.json"), "utf8");
    expect(saved).toContain("小王");
    expect(saved).toContain("演练");
    expect(saved).not.toContain("pickup");
  });

  it("多维表格写入失败时退回 JSON，字段里没有完整订单号", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-mcd-bitable-"));
    const file = join(dir, "ledger.json");
    const client: BitableClient = {
      async batchCreate() {
        throw new Error("403");
      },
      async batchUpdate() {
        throw new Error("403");
      },
    };
    const ledger = new BitableLedger(client, "app", "tbl", new JsonLedger(file), new FileRecordIndex(join(dir, "index.json")));
    const rows = buildLedgerRows({
      datetime: "2026-10-19T12:00:00+08:00",
      storeName: "演示门店 A",
      orderId: fullOrder,
      dryRun: false,
      scene: "加班餐",
      shares: [
        {
          openId: "owner",
          rawFen: 100,
          shareFen: 101,
          lines: [{ productCode: "1440", productName: "麦辣鸡腿汉堡", quantity: 1, subtotalFen: 100 }],
        },
      ],
      names: new Map([["owner", "发起人"]]),
      orderFen: 101,
      payStatus: "待支付",
    });
    const written = await ledger.write(rows);
    expect(written.destination).toBe("json");
    const saved = readFileSync(file, "utf8");
    expect(saved).not.toContain(fullOrder);
    expect(saved).toContain("0009");
    const fields = bitableFields(rows[0]!);
    expect(JSON.stringify(fields)).not.toContain(fullOrder);
    expect(fields[LEDGER_FIELDS.orderTail]).toBe("0009");
    expect(fields[LEDGER_FIELDS.person]).toEqual([{ id: "owner" }]);
    expect(fields).not.toHaveProperty("phone");
  });
});
