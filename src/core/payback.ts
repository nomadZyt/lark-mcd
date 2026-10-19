import { formatYuanFromFen } from "./money.js";

export interface PaybackInput {
  saveFen: number;
  cardPriceFen: number | null;
  weeklyFrequency: number | null;
  orderSampleSize: number;
  eligibleCount: number;
  saveSource: "quote" | "reference";
  cardPriceSource: "quote" | "manual" | "unknown";
  frequencySource: "orders" | "manual" | "unknown";
  cardLabel: string;
}

export interface PaybackResult {
  kind: "no-discount" | "need-input" | "ready";
  repeats: number | null;
  days: number | null;
  lines: string[];
}

const RULES = "规则以麦当劳 App 内卡面说明为准。本工具只做计算，不会替你购买会员卡。";

/** 只给出中性的计算结果。不代买，也不评价值不值。 */
export function computePayback(input: PaybackInput): PaybackResult {
  if (input.eligibleCount <= 0 || input.saveFen <= 0) {
    return {
      kind: "no-discount",
      repeats: null,
      days: null,
      lines: ["本单没有随单购优惠", RULES],
    };
  }

  const saveLabel = formatYuanFromFen(input.saveFen);
  const reference = input.saveSource === "reference" ? "（参考值）" : "";
  const head = `本单有 ${input.eligibleCount} 件可享随单购${input.cardLabel}价，加购后餐品可省 ${saveLabel}${reference}`;

  if (input.cardPriceFen === null || input.cardPriceFen <= 0) {
    return {
      kind: "need-input",
      repeats: null,
      days: null,
      lines: [head, "卡价还不确定。请填写你在麦当劳 App 里看到的卡价。", RULES],
    };
  }

  const repeats = Math.ceil(input.cardPriceFen / input.saveFen);
  const priceFrom = input.cardPriceSource === "manual" ? "你填写的" : "核价结果";
  const priceLine = `卡价 ${formatYuanFromFen(input.cardPriceFen)}（来源：${priceFrom}）`;

  if (input.weeklyFrequency === null || input.weeklyFrequency <= 0) {
    const freqHint =
      input.orderSampleSize < 3 ? "最近订单不足 3 笔，请选择每周大约几次。" : "请选择每周大约几次。";
    return {
      kind: "need-input",
      repeats,
      days: null,
      lines: [head, priceLine, freqHint, `按这个卡价，大约第 ${repeats} 次回本。`, RULES],
    };
  }

  const days = Math.ceil((repeats / input.weeklyFrequency) * 7);
  const freqFrom = input.frequencySource === "orders" ? "来自最近订单" : "你的选择";
  return {
    kind: "ready",
    repeats,
    days,
    lines: [
      head,
      priceLine,
      `你的频率：每周约 ${input.weeklyFrequency} 次（${freqFrom}）`,
      `按你每周约 ${input.weeklyFrequency} 次的频率，大约 ${repeats} 次（约 ${days} 天）回本。`,
      RULES,
    ],
  };
}

export function cardLabelFromDiscount(discountType: string | undefined): string {
  if (discountType?.includes("早餐卡")) return "早餐卡";
  return "麦金卡";
}

export interface DatedOrder {
  createTime: string;
}

/** 不足 3 笔时返回 null，交给用户自己选频率。 */
export function frequencyFromOrders(orders: DatedOrder[]): { weekly: number; sample: number } | null {
  const times = orders
    .map((order) => Date.parse(order.createTime.replace(" ", "T")))
    .filter((time) => !Number.isNaN(time))
    .sort((left, right) => left - right);
  if (times.length < 3) return null;
  const span = Math.max(times[times.length - 1]! - times[0]!, 7 * 24 * 60 * 60 * 1000);
  const weeks = span / (7 * 24 * 60 * 60 * 1000);
  return { weekly: Math.max(1, Math.round(times.length / weeks)), sample: times.length };
}
