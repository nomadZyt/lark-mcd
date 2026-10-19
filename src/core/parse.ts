import { z } from "zod";
import type { BusinessEnvelope, MealInfo, WithOrderArg } from "./types.js";

const envelopeSchema = z
  .object({
    success: z.boolean(),
    code: z.number(),
    message: z.string().optional().default(""),
    datetime: z.string().optional(),
    traceId: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

export function parseMcpPayload(payload: unknown): BusinessEnvelope {
  if (typeof payload === "string") return parseMcpText(payload);
  if (!payload || typeof payload !== "object") {
    throw new Error("无法解析 MCP 响应");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.success === "boolean") return asEnvelope(record);
  const result = record.result;
  if (result && typeof result === "object" && Array.isArray((result as { content?: unknown }).content)) {
    return parseContent((result as { content: unknown[] }).content);
  }
  if (Array.isArray(record.content)) return parseContent(record.content);
  throw new Error("无法解析 MCP 响应");
}

export function parseMcpText(text: string): BusinessEnvelope {
  const marker = '{"success"';
  const index = text.indexOf(marker);
  if (index < 0) {
    const markdown = text.trim();
    if (!markdown) throw new Error("空响应");
    return {
      success: true,
      code: 200,
      message: "markdown",
      markdown,
      data: { markdown },
    };
  }
  return asEnvelope(parseFirstJsonObject(text.slice(index)));
}

function parseContent(content: unknown[]): BusinessEnvelope {
  const first = content[0];
  if (!first || typeof first !== "object") throw new Error("无法解析 MCP 响应");
  const block = first as Record<string, unknown>;
  if (block.json && typeof block.json === "object") return asEnvelope(block.json);
  if (typeof block.text === "string") return parseMcpText(block.text);
  throw new Error("无法解析 MCP 响应");
}

function asEnvelope(value: unknown): BusinessEnvelope {
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) throw new Error("MCP 响应缺少 success 或 code");
  return {
    success: parsed.data.success,
    code: parsed.data.code,
    message: parsed.data.message,
    datetime: parsed.data.datetime,
    traceId: parsed.data.traceId,
    data: parsed.data.data,
  };
}

export function parseFirstJsonObject(input: string): unknown {
  const start = input.indexOf("{");
  if (start < 0) throw new Error("没有 JSON");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < input.length; index += 1) {
    const char = input[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(input.slice(start, index + 1)) as unknown;
    }
  }
  throw new Error("JSON 不完整");
}

const withOrderSchema = z
  .object({
    cardId: z.string().optional(),
    cardType: z.number().optional(),
    membershipCode: z.string().optional(),
    membershipSpecId: z.string().optional(),
    specId: z.string().optional(),
  })
  .passthrough();

/** query-meals 的 specId 与 calculate-price 的 membershipSpecId 按同一值映射，尚未用真实下单核对。 */
export function normalizeWithOrder(value: unknown): WithOrderArg | undefined {
  const parsed = withOrderSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const spec = parsed.data.membershipSpecId ?? parsed.data.specId;
  const result: WithOrderArg = {};
  if (parsed.data.cardId) result.cardId = parsed.data.cardId;
  if (parsed.data.cardType !== undefined) result.cardType = parsed.data.cardType;
  if (parsed.data.membershipCode) result.membershipCode = parsed.data.membershipCode;
  if (spec) result.membershipSpecId = spec;
  return Object.keys(result).length > 0 ? result : undefined;
}

const mealSchema = z
  .object({
    name: z.string(),
    currentPrice: z.string(),
    originalPrice: z.string().optional(),
    discountType: z.string().nullable().optional(),
    canWithOrder: z.boolean().optional(),
    isCanWithOrder: z.boolean().optional(),
    withOrder: z.unknown().optional(),
  })
  .passthrough();

export function parseMealsPayload(data: unknown): { meals: MealInfo[]; frequentCode?: string } {
  if (!data || typeof data !== "object") return { meals: [] };
  const record = data as Record<string, unknown>;
  const meals: MealInfo[] = [];
  const rawMeals = record.meals;
  if (rawMeals && typeof rawMeals === "object" && !Array.isArray(rawMeals)) {
    for (const [code, value] of Object.entries(rawMeals)) {
      const meal = toMeal(code, value);
      if (meal) meals.push(meal);
    }
  } else if (Array.isArray(rawMeals)) {
    for (const value of rawMeals) {
      if (!value || typeof value !== "object") continue;
      const code = "code" in value && typeof value.code === "string" ? value.code : "";
      const meal = toMeal(code, value);
      if (meal) meals.push(meal);
    }
  }
  return { meals, frequentCode: readFrequentCode(record.frequent) };
}

function toMeal(code: string, value: unknown): MealInfo | undefined {
  const parsed = mealSchema.safeParse(value);
  if (!parsed.success || !code) return undefined;
  const discountType = parsed.data.discountType ?? undefined;
  return {
    code,
    name: parsed.data.name,
    currentPrice: parsed.data.currentPrice,
    originalPrice: parsed.data.originalPrice ?? parsed.data.currentPrice,
    discountType: discountType || undefined,
    canWithOrder: Boolean(parsed.data.canWithOrder ?? parsed.data.isCanWithOrder),
    withOrder: normalizeWithOrder(parsed.data.withOrder),
  };
}

/** 样例里 frequent 是对象，文档示例里是数组，两种都认。 */
export function readFrequentCode(frequent: unknown): string | undefined {
  if (!frequent) return undefined;
  if (Array.isArray(frequent)) {
    const first = frequent[0];
    if (first && typeof first === "object" && "code" in first && typeof first.code === "string") {
      return first.code;
    }
    return undefined;
  }
  if (typeof frequent === "object" && "code" in frequent && typeof frequent.code === "string") {
    return frequent.code;
  }
  return undefined;
}

export function explainMcpFailure(envelope: BusinessEnvelope): string {
  switch (envelope.code) {
    case 401:
      return "麦当劳 MCP 凭证失效了，请在本机更新 .env 后重启";
    case 429:
      return "请求太频繁，请稍后再试";
    case 60006:
      return "这个时段买不到这份餐品，换一个吧";
    case 600050:
      return "请用 /麦麦 门店 城市 关键词 搜索";
    case 600012:
      return "这张券当前不可用";
    default: {
      const trace = envelope.traceId ? `（traceId ${envelope.traceId}）` : "";
      return `${envelope.message || "麦当劳接口返回了错误"}${trace}`;
    }
  }
}

export function redact(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(app[_-]?secret|token|secret|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

export function orderTail(orderId: string): string {
  const clean = orderId.trim();
  if (clean.length <= 4) return clean;
  return `…${clean.slice(-4)}`;
}
