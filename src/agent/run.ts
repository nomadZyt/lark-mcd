import { randomBytes, randomUUID } from "node:crypto";
import { buildCard } from "../cards/build.js";
import { formatYuanFromFen } from "../core/money.js";
import { explainMcpFailure, parseMealsPayload, redact } from "../core/parse.js";
import type { McpClient } from "../core/mcp-client.js";
import { PICKUP_BE_TYPE, PICKUP_ORDER_TYPE, QUOTE_TTL_MS, REFRESH_COOLDOWN_MS, type Trigger } from "../core/types.js";
import type { AppConfig } from "../bot/config.js";
import { AgentError } from "./errors.js";
import type { ProposalNotifier } from "./feishu-dm.js";
import type { MenuCache, MenuItem } from "./menu-cache.js";
import type { AgentProposal, AgentQuote, ProposalStore } from "./proposal-store.js";
import type { RateLimiter } from "./rate-limit.js";
import { readOrderDetail, readOrderList, readPrice, readStores } from "./read-mcp.js";

const MOCK_NOTICE = "当前是演示数据，价格和门店不代表实时结果。";
const STORE_CODE = /^[A-Za-z0-9_-]{1,40}$/;
const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const QUOTE_ID = /^q_[0-9a-f]{16}$/;

export type AgentCommand =
  | { type: "stores"; city: string; keyword: string }
  | { type: "menu"; storeCode: string }
  | { type: "quote"; storeCode: string; storeName?: string; items: { productCode: string; quantity: number }[] }
  | { type: "status"; orderId?: string }
  | { type: "propose"; quoteId: string };

export interface CommandContext {
  config: AppConfig;
  mcp: McpClient;
  proposals: ProposalStore;
  limiter: RateLimiter;
  menuCache: MenuCache;
  notifier?: ProposalNotifier;
  now: () => number;
}

const ALLOWED_FLAGS: Record<string, readonly string[]> = {
  stores: ["near"],
  menu: ["store"],
  quote: ["store", "items", "store-name"],
  propose: ["quote"],
  status: ["order"],
};

const FORBIDDEN = new Set(["order", "cancel", "create-order", "cancel-order"]);

export type ParseResult =
  | { kind: "help" }
  | { kind: "error"; command?: string; code: string; message: string }
  | { kind: "command"; command: AgentCommand; json: boolean };

export function parseAgentArgv(argv: string[]): ParseResult {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { kind: "help" };
  if (argv[0] !== "agent") {
    return {
      kind: "error",
      code: "BAD_ARGS",
      message: "用法：lark-mcd agent <stores|menu|quote|status|propose> --json",
    };
  }
  const rest = argv.slice(1);
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") return { kind: "help" };
  const name = rest[0] ?? "";
  if (FORBIDDEN.has(name)) {
    return {
      kind: "error",
      command: name,
      code: "UNKNOWN_COMMAND",
      message: "Agent 入口没有下单或取消命令。下单和取消只能由 Token 主人在飞书卡片上点按钮。",
    };
  }
  if (!(name in ALLOWED_FLAGS)) {
    return {
      kind: "error",
      command: name,
      code: "UNKNOWN_COMMAND",
      message: `没有这个命令：${name}。可用命令：stores、menu、quote、status、propose。`,
    };
  }
  const flags = new Map<string, string>();
  let json = false;
  for (let index = 1; index < rest.length; index += 1) {
    const token = rest[index] ?? "";
    if (!token.startsWith("--")) {
      return { kind: "error", command: name, code: "BAD_ARGS", message: `无法识别的参数 ${token}` };
    }
    const key = token.slice(2);
    if (key === "json") {
      json = true;
      continue;
    }
    if (!ALLOWED_FLAGS[name]?.includes(key)) {
      return { kind: "error", command: name, code: "BAD_ARGS", message: `命令 ${name} 不接受 --${key}` };
    }
    if (flags.has(key)) {
      return { kind: "error", command: name, code: "BAD_ARGS", message: `参数 --${key} 重复了` };
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { kind: "error", command: name, code: "BAD_ARGS", message: `参数 --${key} 缺少值` };
    }
    flags.set(key, value);
    index += 1;
  }
  try {
    return { kind: "command", command: buildCommand(name, flags), json };
  } catch (error) {
    if (error instanceof AgentError) {
      return { kind: "error", command: name, code: error.code, message: error.message };
    }
    throw error;
  }
}

function buildCommand(name: string, flags: Map<string, string>): AgentCommand {
  if (name === "stores") {
    const near = flags.get("near");
    if (!near) throw new AgentError("BAD_ARGS", "stores 需要 --near \"城市 关键词\"");
    if (near.length > 80) throw new AgentError("BAD_ARGS", "--near 太长");
    const parts = near.trim().split(/\s+/);
    const city = parts[0];
    const keyword = parts.slice(1).join(" ");
    if (!city || !keyword) {
      throw new AgentError("BAD_ARGS", "stores 的 --near 需要「城市 关键词」，例如「上海 人民广场」");
    }
    return { type: "stores", city, keyword };
  }
  if (name === "menu") {
    const storeCode = requireStore(flags.get("store"), "menu");
    return { type: "menu", storeCode };
  }
  if (name === "quote") {
    const storeCode = requireStore(flags.get("store"), "quote");
    const items = parseItems(flags.get("items"));
    const storeName = flags.get("store-name")?.trim();
    if (storeName && storeName.length > 40) throw new AgentError("BAD_ARGS", "--store-name 太长");
    return { type: "quote", storeCode, storeName: storeName || undefined, items };
  }
  if (name === "propose") {
    const quoteId = flags.get("quote");
    if (!quoteId || !QUOTE_ID.test(quoteId)) throw new AgentError("QUOTE_NOT_FOUND", "没有这份报价，请先核价");
    return { type: "propose", quoteId };
  }
  const orderId = flags.get("order");
  if (orderId !== undefined && !ORDER_ID.test(orderId)) {
    throw new AgentError("BAD_ARGS", "订单号格式无法识别");
  }
  return { type: "status", orderId };
}

function requireStore(value: string | undefined, command: string): string {
  if (!value || !STORE_CODE.test(value)) {
    throw new AgentError("BAD_ARGS", `${command} 需要 --store <storeCode>`);
  }
  return value;
}

function parseItems(raw: string | undefined): { productCode: string; quantity: number }[] {
  if (!raw) throw new AgentError("BAD_ARGS", "quote 需要 --items，例如 [{\"code\":\"1440\",\"qty\":1}]");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AgentError("BAD_ARGS", "items 需要是 JSON 数组，例如 [{\"code\":\"1440\",\"qty\":1}]");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new AgentError("BAD_ARGS", "items 至少要有一个商品");
  }
  if (parsed.length > 20) throw new AgentError("BAD_ARGS", "一次最多核价 20 个商品");
  return parsed.map((item) => {
    if (!item || typeof item !== "object") throw new AgentError("BAD_ARGS", "items 里有无法识别的商品");
    const record = item as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : record.productCode;
    const qty = record.qty ?? record.quantity ?? 1;
    if (typeof code !== "string" || !STORE_CODE.test(code)) {
      throw new AgentError("BAD_ARGS", "商品编码无法识别");
    }
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > 20) {
      throw new AgentError("BAD_ARGS", "商品数量需要是 1 到 20 的整数");
    }
    return { productCode: code, quantity: qty };
  });
}

export async function runCommand(command: AgentCommand, ctx: CommandContext): Promise<Record<string, unknown>> {
  switch (command.type) {
    case "stores":
      return stores(command, ctx);
    case "menu":
      return menu(command, ctx);
    case "quote":
      return quote(command, ctx);
    case "status":
      return status(command, ctx);
    case "propose":
      return propose(command, ctx);
  }
}

export function envelope(config: AppConfig, command: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: true,
    command,
    mode: config.mode,
    orderPlaced: false,
    ...(config.mode === "mock" ? { notice: MOCK_NOTICE } : {}),
    ...extra,
  };
}

async function stores(command: Extract<AgentCommand, { type: "stores" }>, ctx: CommandContext): Promise<Record<string, unknown>> {
  const envelopeResult = await ctx.mcp.call(
    "query-nearby-stores",
    { beType: PICKUP_BE_TYPE, searchType: 2, city: command.city, keyword: command.keyword },
    trigger(ctx, "agent.stores"),
  );
  if (!envelopeResult.success) throw mcpError(envelopeResult);
  return { stores: readStores(envelopeResult.data) };
}

async function menu(command: Extract<AgentCommand, { type: "menu" }>, ctx: CommandContext): Promise<Record<string, unknown>> {
  const now = ctx.now();
  const cached = ctx.menuCache.get(command.storeCode, now);
  if (cached) return { storeCode: command.storeCode, cached: true, meals: cached };
  const envelopeResult = await ctx.mcp.call(
    "query-meals",
    { storeCode: command.storeCode, orderType: PICKUP_ORDER_TYPE, beType: PICKUP_BE_TYPE },
    trigger(ctx, "agent.menu"),
  );
  if (!envelopeResult.success) throw mcpError(envelopeResult);
  const parsed = parseMealsPayload(envelopeResult.data);
  const meals: MenuItem[] = parsed.meals.map((meal) => ({
    code: meal.code,
    name: meal.name,
    currentPrice: meal.currentPrice,
    originalPrice: meal.originalPrice,
  }));
  ctx.menuCache.put(command.storeCode, meals, now);
  return { storeCode: command.storeCode, cached: false, meals };
}

async function quote(command: Extract<AgentCommand, { type: "quote" }>, ctx: CommandContext): Promise<Record<string, unknown>> {
  const envelopeResult = await ctx.mcp.call(
    "calculate-price",
    {
      storeCode: command.storeCode,
      orderType: PICKUP_ORDER_TYPE,
      beType: PICKUP_BE_TYPE,
      needTableware: false,
      items: command.items.map((item) => ({ productCode: item.productCode, quantity: item.quantity })),
    },
    trigger(ctx, "agent.quote"),
  );
  if (!envelopeResult.success) throw mcpError(envelopeResult);
  const price = readPrice(envelopeResult.data);
  if (!price || price.lines.length === 0) throw new AgentError("MCP_ERROR", "核价结果不完整");
  const now = ctx.now();
  const takeWayCode = price.takeWays.some((way) => way.code === "eat-in") ? "eat-in" : (price.takeWays[0]?.code ?? "eat-in");
  const stored: AgentQuote = {
    id: `q_${randomBytes(8).toString("hex")}`,
    storeCode: command.storeCode,
    storeName: command.storeName || command.storeCode,
    items: command.items.map((item) => ({
      productCode: item.productCode,
      quantity: item.quantity,
      name: price.lines.find((line) => line.productCode === item.productCode)?.productName,
    })),
    priceFen: price.priceFen,
    discountFen: price.discountFen,
    tablewareFen: price.tablewareFen,
    lines: price.lines,
    takeWays: price.takeWays,
    takeWayCode,
    needTableware: false,
    quotedAt: now,
  };
  ctx.proposals.saveQuote(stored, now);
  const takeWayTitle = price.takeWays.find((way) => way.code === takeWayCode)?.title ?? takeWayCode;
  return {
    quoteId: stored.id,
    expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(),
    ttlMs: QUOTE_TTL_MS,
    storeCode: stored.storeCode,
    storeName: stored.storeName,
    takeWay: takeWayTitle,
    totalFen: stored.priceFen,
    totalText: formatYuanFromFen(stored.priceFen),
    discountFen: stored.discountFen,
    lines: stored.lines.map((line) => ({
      code: line.productCode,
      name: line.productName,
      qty: line.quantity,
      subtotalFen: line.subtotalFen,
      subtotalText: formatYuanFromFen(line.subtotalFen),
    })),
  };
}

async function status(command: Extract<AgentCommand, { type: "status" }>, ctx: CommandContext): Promise<Record<string, unknown>> {
  if (command.orderId) {
    const now = ctx.now();
    if (!ctx.limiter.claimRefresh(command.orderId, now, REFRESH_COOLDOWN_MS)) {
      throw new AgentError("COOLDOWN", "请等几秒再刷新");
    }
    const envelopeResult = await ctx.mcp.call(
      "query-order",
      { orderId: command.orderId },
      trigger(ctx, "agent.status"),
      { orderId: command.orderId, now },
    );
    if (!envelopeResult.success) throw mcpError(envelopeResult);
    return { order: readOrderDetail(envelopeResult.data, command.orderId) };
  }
  const envelopeResult = await ctx.mcp.call("order-list", {}, trigger(ctx, "agent.status"));
  if (!envelopeResult.success) throw mcpError(envelopeResult);
  return { orders: readOrderList(envelopeResult.data) };
}

async function propose(command: Extract<AgentCommand, { type: "propose" }>, ctx: CommandContext): Promise<Record<string, unknown>> {
  const quote = ctx.proposals.getQuote(command.quoteId);
  if (!quote) throw new AgentError("QUOTE_NOT_FOUND", "没有这份报价，请先核价");
  const now = ctx.now();
  if (now - quote.quotedAt > QUOTE_TTL_MS) throw new AgentError("QUOTE_EXPIRED", "报价已过期，请重新核价");
  const notifier = ctx.notifier ?? missingNotifier();
  if (!ctx.config.ownerOpenId) {
    throw new AgentError("NOT_CONFIGURED", "缺少 OWNER_OPEN_ID，无法把确认卡片推给 Token 主人");
  }
  const proposal: AgentProposal = {
    id: `p_${randomBytes(8).toString("hex")}`,
    quoteId: quote.id,
    status: "pending",
    createdAt: now,
    quote,
  };
  const takeWayTitle = quote.takeWays.find((way) => way.code === quote.takeWayCode)?.title ?? quote.takeWayCode;
  const card = buildCard({
    kind: "agent-propose",
    sessionId: proposal.id,
    storeName: quote.storeName,
    lines: quote.lines.map((line) => ({
      name: line.productName,
      quantity: line.quantity,
      subtotalFen: line.subtotalFen,
    })),
    totalFen: quote.priceFen,
    takeWayTitle,
    dryRun: ctx.config.dryRun,
  });
  ctx.proposals.saveProposal(proposal, now);
  try {
    await notifier.send(ctx.config.ownerOpenId, card);
  } catch (error) {
    ctx.proposals.updateStatus(proposal.id, "dismissed", now);
    const detail = error instanceof Error ? redact(error.message) : "";
    const message = detail && detail.length < 180 ? `飞书确认卡片没有发出：${detail}` : "飞书确认卡片没有发出";
    throw new AgentError("DELIVER_FAILED", message);
  }
  return {
    proposalId: proposal.id,
    quoteId: quote.id,
    status: "pending" as const,
    delivered: true,
    message: "已推送到飞书，请 Token 主人在卡片上点确认。这一步没有调用下单接口。",
  };
}

function missingNotifier(): ProposalNotifier {
  throw new AgentError("NOT_CONFIGURED", "缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET，无法把确认卡片推给 Token 主人");
}

function trigger(ctx: CommandContext, action: Trigger["action"]): Trigger {
  return {
    kind: "agent",
    eventId: `agent-${randomUUID()}`,
    operatorOpenId: ctx.config.ownerOpenId,
    action,
  };
}

function mcpError(envelopeResult: { code: number; message: string; traceId?: string }): AgentError {
  return new AgentError(
    "MCP_ERROR",
    explainMcpFailure({ success: false, code: envelopeResult.code, message: envelopeResult.message, traceId: envelopeResult.traceId }),
  );
}
