import type { PriceQuote, QuoteLine } from "./session.js";

/** 从 calculate-price 的 data 里取出分单位的核价。 */
export function readPriceQuote(data: unknown): PriceQuote | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (typeof record.price !== "number" || !Array.isArray(record.productList)) return null;
  const lines: QuoteLine[] = record.productList.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const line = item as Record<string, unknown>;
    if (typeof line.productCode !== "string" || typeof line.productName !== "string") return [];
    return [
      {
        productCode: line.productCode,
        productName: line.productName,
        quantity: typeof line.quantity === "number" ? line.quantity : 1,
        subtotalFen: typeof line.subtotal === "number" ? line.subtotal : 0,
      },
    ];
  });
  const takeWays = Array.isArray(record.takeWayList)
    ? record.takeWayList.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const way = item as Record<string, unknown>;
        if (typeof way.code !== "string" || typeof way.title !== "string") return [];
        return [{ code: way.code, title: way.title }];
      })
    : [];
  return {
    priceFen: record.price,
    discountFen: typeof record.discount === "number" ? record.discount : 0,
    tablewareFen: typeof record.tablewarePrice === "number" ? record.tablewarePrice : 0,
    lines,
    takeWays:
      takeWays.length > 0
        ? takeWays
        : [
            { code: "eat-in", title: "堂食" },
            { code: "locker-out", title: "外带" },
          ],
  };
}
