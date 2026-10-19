/** 金额一律用「分」做整数。卡片上再格式化成元。 */

const YUAN_PATTERN = /^[+-]?\d+(\.\d+)?$/;

export function yuanStringToFen(input: string): number {
  const text = input.trim();
  if (!YUAN_PATTERN.test(text)) {
    throw new Error(`无法解析金额：${input}`);
  }
  const negative = text.startsWith("-");
  const body = text.replace(/^[+-]/, "");
  const [whole = "0", fraction = ""] = body.split(".");
  const digits = `${fraction}000`.slice(0, 3);
  let fen = Number(whole) * 100 + Number(digits.slice(0, 2));
  if (digits[2]! >= "5") fen += 1;
  return negative ? -fen : fen;
}

/** 4400 → ¥44.0，720 → ¥7.2。至少保留一位小数。 */
export function formatYuanFromFen(fen: number): string {
  if (!Number.isInteger(fen)) {
    throw new Error("金额必须以分为整数");
  }
  const negative = fen < 0;
  const fixed = (Math.abs(fen) / 100).toFixed(2);
  const trimmed = fixed.endsWith("0") ? fixed.slice(0, -1) : fixed;
  return `${negative ? "-" : ""}¥${trimmed}`;
}

export function fenToYuanNumber(fen: number): number {
  if (!Number.isInteger(fen)) {
    throw new Error("金额必须以分为整数");
  }
  return fen / 100;
}
