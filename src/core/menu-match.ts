import type { MealInfo } from "./types.js";

export type MenuMatch =
  | { kind: "quote"; meals: MealInfo[] }
  | { kind: "pick"; meals: MealInfo[] }
  | { kind: "none" };

const SEPARATOR = /加上|以及|还有|和|跟|加|\+|＋|，|,|、/;
const PREFIX = /^(?:我想吃|我想要|给我来|给我|帮我|来一份|要一份|一份|一个|一杯|一套|来|要|点)+/;

/** 按餐品名模糊匹配当前菜单。唯一命中就核价，多个或没有则交给菜单卡片。 */
export function matchMeals(query: string, meals: MealInfo[]): MenuMatch {
  const parts = query
    .split(SEPARATOR)
    .map((part) => cleanPart(part))
    .filter((part) => compact(part).length > 0);
  if (parts.length === 0) return { kind: "none" };
  if (parts.length === 1) return matchOne(parts[0]!, meals);

  const quoted: MealInfo[] = [];
  const picks: MealInfo[] = [];
  for (const part of parts) {
    const found = matchOne(part, meals);
    if (found.kind === "quote") quoted.push(...found.meals);
    else if (found.kind === "pick") picks.push(...found.meals);
  }
  if (quoted.length === 0 && picks.length === 0) return { kind: "none" };
  if (picks.length === 0) return { kind: "quote", meals: dedupe(quoted) };
  return { kind: "pick", meals: dedupe([...quoted, ...picks]) };
}

function matchOne(raw: string, meals: MealInfo[]): MenuMatch {
  const query = cleanPart(raw);
  const needle = compact(query);
  if (!needle) return { kind: "none" };

  const byCode = meals.filter((meal) => meal.code === query || meal.code === needle);
  if (byCode.length === 1) return { kind: "quote", meals: byCode };

  const exact = meals.filter((meal) => compact(meal.name) === needle);
  if (exact.length === 1) return { kind: "quote", meals: exact };
  if (exact.length > 1) return { kind: "pick", meals: exact };

  const partial = meals.filter((meal) => compact(meal.name).includes(needle));
  if (partial.length === 1) return { kind: "quote", meals: partial };
  if (partial.length > 1) return { kind: "pick", meals: partial };

  const contained = quoteContained(needle, meals);
  if (contained) return { kind: "quote", meals: contained };

  if (needle.length < 2) return { kind: "none" };
  const scored = meals
    .map((meal) => ({ meal, score: dice(needle, compact(meal.name)) }))
    .filter((row) => row.score >= 0.45)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { kind: "none" };
  const best = scored[0]!;
  const second = scored[1]?.score ?? 0;
  if (best.score >= 0.62 && best.score - second >= 0.12) return { kind: "quote", meals: [best.meal] };
  return { kind: "pick", meals: scored.slice(0, 5).map((row) => row.meal) };
}

function quoteContained(needle: string, meals: MealInfo[]): MealInfo[] | undefined {
  const contained = meals
    .filter((meal) => {
      const name = compact(meal.name);
      return name.length >= 2 && needle.includes(name);
    })
    .sort((a, b) => compact(b.name).length - compact(a.name).length);
  const picked: MealInfo[] = [];
  let rest = needle;
  for (const meal of contained) {
    const name = compact(meal.name);
    if (!rest.includes(name)) continue;
    if (picked.some((chosen) => compact(chosen.name).includes(name))) continue;
    picked.push(meal);
    rest = rest.replace(name, "");
  }
  const leftover = rest.replace(/[和跟加要来个份杯套一]/g, "");
  if (picked.length > 0 && leftover.length === 0) return picked;
  return undefined;
}

function cleanPart(part: string): string {
  return part.replace(PREFIX, "").trim();
}

function compact(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "").replace(/[，,。.!！?？、+＋/／]/g, "");
}

function dedupe(meals: MealInfo[]): MealInfo[] {
  const seen = new Set<string>();
  const result: MealInfo[] = [];
  for (const meal of meals) {
    if (seen.has(meal.code)) continue;
    seen.add(meal.code);
    result.push(meal);
  }
  return result;
}

function dice(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index += 1) {
    const gram = left.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const gram = right.slice(index, index + 2);
    const remaining = counts.get(gram) ?? 0;
    if (remaining > 0) {
      overlap += 1;
      counts.set(gram, remaining - 1);
    }
  }
  return (2 * overlap) / (left.length - 1 + (right.length - 1));
}
