import { describe, expect, it } from "vitest";
import { formatYuanFromFen, yuanStringToFen } from "../src/core/money.js";

describe("金额", () => {
  it("把元字符串换成整数分", () => {
    expect(yuanStringToFen("7.2")).toBe(720);
    expect(yuanStringToFen("22.5")).toBe(2250);
    expect(yuanStringToFen("49.9")).toBe(4990);
    expect(yuanStringToFen("7.25")).toBe(725);
    expect(yuanStringToFen("7.255")).toBe(726);
    expect(yuanStringToFen("0")).toBe(0);
  });

  it("把分格式化成元，4400 显示为 ¥44.0", () => {
    expect(formatYuanFromFen(4400)).toBe("¥44.0");
    expect(formatYuanFromFen(720)).toBe("¥7.2");
    expect(formatYuanFromFen(0)).toBe("¥0.0");
    expect(formatYuanFromFen(1)).toBe("¥0.01");
    expect(formatYuanFromFen(726)).toBe("¥7.26");
  });

  it("拒绝用浮点分", () => {
    expect(() => formatYuanFromFen(1.5)).toThrow(/整数/);
  });
});
