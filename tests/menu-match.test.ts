import { describe, expect, it } from "vitest";
import { loadFixtures } from "../src/core/mock-mcp.js";
import { matchMeals } from "../src/core/menu-match.js";

describe("菜单名字匹配", () => {
  const meals = loadFixtures().meals;

  it("全名和简称都能对上唯一一份", () => {
    expect(matchMeals("麦辣鸡腿汉堡", meals)).toMatchObject({ kind: "quote", meals: [{ code: "1440" }] });
    expect(matchMeals("来一份猪柳", meals)).toMatchObject({ kind: "quote", meals: [{ code: "5022" }] });
    expect(matchMeals("1440", meals)).toMatchObject({ kind: "quote", meals: [{ code: "1440" }] });
  });

  it("多个全名一起点", () => {
    const matched = matchMeals("猪柳蛋麦满分和麦辣鸡翅", meals);
    expect(matched.kind).toBe("quote");
    if (matched.kind !== "quote") return;
    expect(matched.meals.map((meal) => meal.code)).toEqual(["5022", "1700"]);
  });

  it("简称对上好几份时列出候选", () => {
    const matched = matchMeals("麦辣", meals);
    expect(matched.kind).toBe("pick");
    if (matched.kind !== "pick") return;
    expect(matched.meals.map((meal) => meal.name)).toEqual(
      expect.arrayContaining(["麦辣鸡腿汉堡", "麦辣鸡腿汉堡三件套", "麦辣鸡翅"]),
    );
    expect(matched.meals.some((meal) => meal.name.includes("橙"))).toBe(false);
  });

  it("菜单里没有的名字不假装匹配", () => {
    expect(matchMeals("巨无霸", meals).kind).toBe("none");
    expect(matchMeals("麦辣鸡腿汉保", meals)).toMatchObject({ kind: "quote", meals: [{ code: "1440" }] });
  });
});