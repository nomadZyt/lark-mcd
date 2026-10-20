import { describe, expect, it } from "vitest";
import { allocateFen, splitOrderFen } from "../src/core/aa.js";

describe("AA 分摊", () => {
  it("除不尽的分加到发起人，总和等于实付", () => {
    expect(allocateFen([100, 100, 100], 10, 1)).toEqual([3, 4, 3]);
    expect(allocateFen([1, 1], 3, 0)).toEqual([2, 1]);
    expect(allocateFen([0, 0], 5, 0)).toEqual([5, 0]);
  });

  it("同一商品按份数拆开，余数给发起人，再按实付对齐", () => {
    const shares = splitOrderFen({
      portions: [
        { openId: "a", productCode: "x", quantity: 1 },
        { openId: "b", productCode: "x", quantity: 1 },
        { openId: "owner", productCode: "x", quantity: 1 },
      ],
      products: [{ productCode: "x", productName: "汉堡", quantity: 3, subtotalFen: 100 }],
      orderFen: 101,
      initiatorOpenId: "owner",
    });
    expect(shares.reduce((sum, share) => sum + share.shareFen, 0)).toBe(101);
    const owner = shares.find((share) => share.openId === "owner");
    const other = shares.find((share) => share.openId === "a");
    expect(owner?.rawFen).toBe(34);
    expect(other?.rawFen).toBe(33);
    expect(owner!.shareFen).toBeGreaterThan(other!.shareFen);
  });

  it("随机 1 到 10 人、随机商品，1000 组分摊之和等于实付", () => {
    for (let sample = 0; sample < 1000; sample += 1) {
      const next = rng(sample + 1);
      const people = 1 + (next() % 10);
      const initiator = next() % people;
      const productCount = 1 + (next() % 4);
      const portions: { openId: string; productCode: string; quantity: number }[] = [];
      const products: { productCode: string; productName: string; quantity: number; subtotalFen: number }[] = [];
      for (let product = 0; product < productCount; product += 1) {
        const code = `p${product}`;
        let quantity = 0;
        const buyers = 1 + (next() % people);
        for (let buyer = 0; buyer < buyers; buyer += 1) {
          const qty = 1 + (next() % 3);
          quantity += qty;
          portions.push({ openId: `u${buyer % people}`, productCode: code, quantity: qty });
        }
        products.push({
          productCode: code,
          productName: `餐品${product}`,
          quantity,
          subtotalFen: next() % 8000,
        });
      }
      const rawHint = products.reduce((sum, product) => sum + product.subtotalFen, 0);
      const orderFen = rawHint + (next() % 300);
      const shares = splitOrderFen({
        portions,
        products,
        orderFen,
        initiatorOpenId: `u${initiator}`,
      });
      expect(shares.reduce((sum, share) => sum + share.shareFen, 0)).toBe(orderFen);
      const weights = shares.map((share) => share.rawFen);
      const index = shares.findIndex((share) => share.openId === `u${initiator}`);
      if (index >= 0 && weights.some((weight) => weight > 0)) {
        const floors = allocateFen(weights, orderFen, index);
        expect(shares.map((share) => share.shareFen)).toEqual(floors);
      }
    }
  });
});

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state;
  };
}
