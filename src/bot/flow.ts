import { buildCard } from "../cards/build.js";
import type { FeishuCard } from "../cards/types.js";
import { GuardError } from "../core/guard.js";
import type { McpClient } from "../core/mcp-client.js";
import { yuanStringToFen } from "../core/money.js";
import { explainMcpFailure, parseMealsPayload, redact } from "../core/parse.js";
import { cardLabelFromDiscount, computePayback, frequencyFromOrders } from "../core/payback.js";
import {
  PICKUP_BE_TYPE,
  PICKUP_ORDER_TYPE,
  QUOTE_TTL_MS,
  type ActionName,
  type BusinessEnvelope,
  type MealInfo,
  type OrderItem,
  type Trigger,
} from "../core/types.js";
import { eligibleWithOrder, isCombo, type Draft, type QuoteLine, SessionBook } from "./session.js";
import { readPriceQuote } from "./quote.js";
import { itemsFromState, type StateStore } from "./state.js";
import type { AgentProposal, ProposalStore } from "../agent/proposal-store.js";

export interface IncomingMessage {
  eventId: string;
  openId: string;
  chatId: string;
  chatType: "p2p" | "group";
  text: string;
}

export interface CardInput {
  eventId: string;
  operatorOpenId: string;
  messageId?: string;
  chatId?: string;
  action: string;
  sessionId?: string;
  takeWay?: string;
  storeCode?: string;
  storeName?: string;
  productCode?: string;
  delta?: number;
  scene?: string;
  operatorName?: string;
  form: Record<string, string>;
}

export interface FlowResult {
  toast?: { type: "info" | "success" | "warning" | "error"; content: string };
  card?: FeishuCard;
  text?: string;
  /** 只发给 Token 主人的私聊，例如付款链接。不会发到群里。 */
  direct?: { openId: string; card: FeishuCard };
  /** 刷新私聊卡片时，同步更新群里的那张卡片。 */
  groupPatch?: { messageId: string; card: FeishuCard };
  sessionId?: string;
}

export type Command =
  | { type: "help" }
  | { type: "old-usual" }
  | { type: "store"; city: string; keyword: string }
  | { type: "unknown" };

export function parseCommand(text: string): Command {
  const normalized = text.trim();
  if (!normalized || normalized === "帮助" || normalized === "/麦麦" || normalized === "/麦麦 帮助") {
    return { type: "help" };
  }
  if (normalized === "老样子" || normalized === "「老样子」") return { type: "old-usual" };
  const store = /^\/麦麦\s+门店\s+(\S+)\s+(.+)$/.exec(normalized);
  if (store?.[1] && store[2]) return { type: "store", city: store[1], keyword: store[2].trim() };
  return { type: "unknown" };
}

export const HELP_TEXT = [
  "麦麦卡片",
  "私聊发「老样子」：按本机保存的配方核价。",
  "/麦麦 门店 城市 关键词：设置到店自取的门店。",
  "群里 @我，发送 /麦麦 拼单 午饭 12:00：大家勾选，发起人一个人下单。",
  "下单后会给你麦当劳的付款链接，需要你自己付款。",
  "本工具不自动下单，不自动付款，不轮询，不领券。",
  "信息以麦当劳 App 显示为准。",
].join("\n");

const NOT_OWNER = "只有发起人可以核价和下单";

export class OrderFlow {
  private readonly menu = new Map<string, MealInfo>();
  private lastSearch: { city: string; keyword: string } | undefined;

  constructor(
    private readonly mcp: McpClient,
    private readonly state: StateStore,
    private readonly sessions: SessionBook,
    private readonly options: {
      ownerOpenId: string;
      dryRun: boolean;
      now: () => number;
      proposals?: ProposalStore;
    },
  ) {}

  async onMessage(input: IncomingMessage): Promise<FlowResult> {
    try {
      if (input.chatType === "group") {
        return { text: "群里请 @我，发送：/麦麦 拼单 午饭 12:00。成员只勾选，只有发起人可以核价和下单。" };
      }
      if (input.text.includes("拼单")) {
        return { text: "拼单要在群里 @我，发送：/麦麦 拼单 午饭 12:00" };
      }
      if (input.openId !== this.options.ownerOpenId) {
        return { text: `${NOT_OWNER}。你的 open_id 是 ${input.openId}，写进本机 .env 的 OWNER_OPEN_ID 后重启。` };
      }
      const command = parseCommand(input.text);
      if (command.type === "help" || command.type === "unknown") {
        return { text: command.type === "unknown" ? `没听懂。\n${HELP_TEXT}` : HELP_TEXT };
      }
      if (command.type === "store") return await this.searchStores(input, command.city, command.keyword);
      return await this.oldUsual(input);
    } catch (error) {
      return this.fail(error);
    }
  }

  async onCard(input: CardInput): Promise<FlowResult> {
    try {
      if (input.operatorOpenId !== this.options.ownerOpenId) {
        return { toast: { type: "warning", content: NOT_OWNER } };
      }
      if (input.action === "store.pick") return this.pickStore(input);
      const loaded = this.resolveDraft(input.sessionId);
      if (loaded.early) return loaded.early;
      const draft = loaded.draft;
      if (!draft || draft.status === "cancelled") {
        return { toast: { type: "error", content: "这张卡片过期了，请重新发送「老样子」" } };
      }
      if (draft.pending) return { toast: { type: "info", content: "正在处理，请稍候" } };
      draft.pending = true;
      try {
        const result = await this.dispatchCard(input, draft);
        this.syncProposal(draft);
        return result;
      } finally {
        draft.pending = false;
      }
    } catch (error) {
      return this.fail(error);
    }
  }

  private async dispatchCard(input: CardInput, draft: Draft): Promise<FlowResult> {
    switch (input.action) {
      case "order.confirm":
        return await this.confirm(input, draft);
      case "order.refresh":
        return await this.refresh(input, draft);
      case "order.cancel":
        return { card: buildCard({ kind: "confirm-cancel", sessionId: draft.id, orderTail: draft.orderId ? tail(draft.orderId) : "尚未下单" }) };
      case "order.cancel.confirm":
        return await this.cancel(input, draft);
      case "order.swap":
        return await this.swap(input, draft);
      case "order.dismiss":
        draft.status = "cancelled";
        return { card: buildCard({ kind: "note", title: "已放下", lines: ["没有下单。想吃的时候再发「老样子」。"] }) };
      case "order.takeway":
        return this.chooseTakeWay(draft, input.takeWay);
      case "order.tableware":
        draft.needTableware = !draft.needTableware;
        return await this.reprice(input, draft);
      case "order.reprice":
        return await this.reprice(input, draft);
      case "payback.calc":
        return await this.payback(input, draft);
      case "order.back":
        return { card: this.cardFor(draft) };
      default:
        return { toast: { type: "warning", content: "这个按钮没有对应的操作" } };
    }
  }

  private async searchStores(input: IncomingMessage, city: string, keyword: string): Promise<FlowResult> {
    const envelope = await this.mcp.call(
      "query-nearby-stores",
      { beType: PICKUP_BE_TYPE, searchType: 2, city, keyword },
      this.trigger("message", input.eventId, input.openId, "store.search"),
    );
    if (!envelope.success) return { text: explainMcpFailure(envelope) };
    const stores = readStores(envelope.data).slice(0, 5);
    if (stores.length === 0) return { text: "没有找到门店，换个关键词试试。" };
    this.lastSearch = { city, keyword };
    return { card: buildCard({ kind: "stores", stores }) };
  }

  private pickStore(input: CardInput): FlowResult {
    if (!input.storeCode || !input.storeName) {
      return { toast: { type: "error", content: "没有门店编号" } };
    }
    const saved = this.state.load();
    saved.store = {
      storeCode: input.storeCode,
      storeName: input.storeName,
      city: this.lastSearch?.city ?? saved.store?.city,
      keyword: this.lastSearch?.keyword ?? saved.store?.keyword,
    };
    this.state.save(saved);
    return {
      card: buildCard({
        kind: "note",
        title: "门店已保存在本机",
        lines: [`以后「老样子」会在${input.storeName}核价。`, "私聊发「老样子」即可。这次没有下单。"],
      }),
    };
  }

  private async oldUsual(input: IncomingMessage): Promise<FlowResult> {
    const saved = this.state.load();
    if (!saved.store?.storeCode || !saved.store.storeName) {
      return { text: "还没有默认门店。请先发送：/麦麦 门店 城市 关键词" };
    }
    const trigger = this.trigger("message", input.eventId, input.openId, "old-usual");
    let items: OrderItem[] | undefined =
      saved.favorite?.items.length ? itemsFromState(saved.favorite.items) : undefined;
    if (!items) {
      const history = await this.mcp.call("order-list", {}, trigger);
      if (!history.success) return { text: explainMcpFailure(history) };
      const completed = readHistory(history.data).find((order) => order.orderStatus === "订单已完成");
      if (completed && completed.products.length > 0) {
        items = completed.products.map((product) => ({
          productCode: product.productCode,
          quantity: product.quantity,
          name: product.productName,
        }));
      } else {
        const menu = await this.mcp.call("query-meals", pickupBase(saved.store.storeCode), trigger);
        if (!menu.success) return { text: explainMcpFailure(menu) };
        const suggestion = this.rememberMeals(menu);
        if (!suggestion) return { text: "没有找到已完成订单，菜单里也没有可推荐的餐品。" };
        const draft = this.newDraft(input, saved.store.storeCode, saved.store.storeName, [this.mealToItem(suggestion, 1)]);
        return { card: this.pricedCard(draft, "还没核价。点「重新核价」按默认搭配算价。") };
      }
    }
    const draft = this.newDraft(input, saved.store.storeCode, saved.store.storeName, items);
    return await this.quoteDraft(draft, trigger);
  }

  private async swap(input: CardInput, draft: Draft): Promise<FlowResult> {
    const trigger = this.trigger("card", input.eventId, input.operatorOpenId, "swap");
    if (this.menu.size === 0) {
      const menu = await this.mcp.call("query-meals", pickupBase(draft.storeCode), trigger);
      if (!menu.success) return { text: explainMcpFailure(menu) };
      this.rememberMeals(menu);
    }
    const next = this.nextMeal(draft);
    if (!next) return { text: "菜单是空的，没法换。" };
    this.applyItems(draft, [this.mealToItem(next, 1)]);
    return await this.quoteDraft(draft, trigger);
  }

  private async reprice(input: CardInput, draft: Draft): Promise<FlowResult> {
    const trigger = this.trigger("card", input.eventId, input.operatorOpenId, "reprice");
    return await this.quoteDraft(draft, trigger);
  }

  private async confirm(input: CardInput, draft: Draft): Promise<FlowResult> {
    if (draft.status === "ordered" && draft.orderId && draft.payH5Url) {
      return { card: this.payCard(draft) };
    }
    if (!draft.quote || this.quoteExpired(draft)) {
      return { card: this.pricedCard(draft, "核价已过期或还没有核价，请先重新核价。") };
    }
    if (this.options.dryRun) {
      return { card: this.dryRunCard(draft) };
    }
    const trigger = this.trigger("card", input.eventId, input.operatorOpenId, "confirm");
    const envelope = await this.mcp.call(
      "create-order",
      {
        ...pickupBase(draft.storeCode),
        takeWayCode: draft.takeWayCode,
        needTableware: draft.needTableware,
        items: draft.items.map((item) => ({ productCode: item.productCode, quantity: item.quantity })),
      },
      trigger,
      { draftId: draft.id, draftStatus: "priced" },
    );
    if (!envelope.success) return { text: explainMcpFailure(envelope), card: this.pricedCard(draft) };
    const created = readCreated(envelope.data);
    if (!created) return { text: "下单结果里没有订单号", card: this.pricedCard(draft) };
    draft.status = "ordered";
    draft.orderId = created.orderId;
    draft.payH5Url = created.payH5Url;
    draft.realTotalFen = created.totalFen;
    this.rememberOrder(draft);
    return { card: this.payCard(draft) };
  }

  private async refresh(input: CardInput, draft: Draft): Promise<FlowResult> {
    if (!draft.orderId) return { toast: { type: "warning", content: "还没有订单，不用刷新" } };
    const trigger = this.trigger("card", input.eventId, input.operatorOpenId, "refresh");
    try {
      const envelope = await this.mcp.call("query-order", { orderId: draft.orderId }, trigger, {
        orderId: draft.orderId,
        now: this.options.now(),
      });
      if (!envelope.success) return { text: explainMcpFailure(envelope), card: this.payCard(draft, explainMcpFailure(envelope)) };
      const detail = readOrderDetail(envelope.data, draft.realTotalFen ?? draft.quote?.priceFen ?? 0);
      draft.realTotalFen = detail.totalFen;
      draft.orderStatus = detail.orderStatus || (detail.pickupCode ? "已支付" : "待支付");
      draft.pickupCode = detail.pickupCode || undefined;
      if (detail.pickupCode) {
        return {
          card: buildCard({
            kind: "paid",
            sessionId: draft.id,
            orderTail: tail(draft.orderId),
            totalFen: detail.totalFen,
            pickupCode: detail.pickupCode,
            lockerCode: detail.lockerCode,
            orderStatus: detail.orderStatus || "已支付",
          }),
        };
      }
      return { card: this.payCard(draft, `状态：${detail.orderStatus || "待支付"}`) };
    } catch (error) {
      if (error instanceof GuardError && error.code === "COOLDOWN") {
        return { toast: { type: "info", content: "请等几秒再刷新" }, card: this.payCard(draft, "请等几秒再刷新") };
      }
      throw error;
    }
  }

  private async cancel(input: CardInput, draft: Draft): Promise<FlowResult> {
    if (this.options.dryRun || !draft.orderId) {
      return {
        card: buildCard({
          kind: "note",
          title: "没有取消订单",
          lines: ["演练模式没有真实订单，也不会调用取消接口。"],
        }),
      };
    }
    const trigger = this.trigger("card", input.eventId, input.operatorOpenId, "cancel");
    const envelope = await this.mcp.call(
      "cancel-order",
      { orderId: draft.orderId, cancelReasonCode: 1 },
      trigger,
      { orderId: draft.orderId },
    );
    if (!envelope.success) return { text: explainMcpFailure(envelope), card: this.payCard(draft) };
    draft.status = "cancelled";
    return { card: buildCard({ kind: "note", title: "订单已取消", lines: ["如果还想吃，重新发送「老样子」。"] }) };
  }

  private async payback(input: CardInput, draft: Draft): Promise<FlowResult> {
    if (!draft.quote) return { card: this.pricedCard(draft, "请先核价，再算会员卡。") };
    const trigger = this.trigger("card", input.eventId, input.operatorOpenId, "payback");
    let spent = 0;
    const spend = async (tool: string, args: Record<string, unknown>): Promise<BusinessEnvelope> => {
      if (spent >= 2) throw new GuardError("BUDGET", "这一步的请求次数到上限了");
      spent += 1;
      return this.mcp.call(tool, args, trigger);
    };
    if (!draft.withOrder && this.menu.size === 0) {
      const menu = await spend("query-meals", pickupBase(draft.storeCode));
      if (menu.success) this.rememberMeals(menu);
      this.refreshEligibility(draft);
    }
    let saveFen = 0;
    let saveSource: "quote" | "reference" = "quote";
    if (draft.withOrder) {
      const second = await spend("calculate-price", {
        ...pickupBase(draft.storeCode),
        needTableware: draft.needTableware,
        withOrder: draft.withOrder,
        items: draft.items.map((item) => ({ productCode: item.productCode, quantity: item.quantity })),
      });
      if (second.success) {
        const quote = readPriceQuote(second.data);
        if (quote) saveFen = draft.quote.priceFen - quote.priceFen;
      }
    }
    if (saveFen <= 0) {
      const reference = referenceSave(draft.items);
      if (reference > 0) {
        saveFen = reference;
        saveSource = "reference";
      }
    }
    let cardPriceFen: number | null = null;
    let cardPriceSource: "quote" | "manual" | "unknown" = "unknown";
    const manual = readManualPrice(input.form.card_price);
    if (input.form.card_price && manual === null) {
      draft.paybackLines = ["卡价没有听懂，请填一个数字，例如 19.9。", "本工具只做计算，不会替你购买会员卡。"];
      return { card: this.pricedCard(draft) };
    }
    if (manual !== null) {
      cardPriceFen = manual;
      cardPriceSource = "manual";
    }
    let weekly: number | null = null;
    let frequencySource: "orders" | "manual" | "unknown" = "unknown";
    let sample = 0;
    const chosen = input.form.freq;
    if (chosen === "1" || chosen === "2" || chosen === "3" || chosen === "5") {
      weekly = Number(chosen);
      frequencySource = "manual";
    } else if (spent < 2) {
      const history = await spend("order-list", {});
      if (history.success) {
        const orders = readHistory(history.data);
        sample = orders.length;
        const computed = frequencyFromOrders(orders);
        if (computed) {
          weekly = computed.weekly;
          frequencySource = "orders";
          sample = computed.sample;
        }
      }
    }
    const result = computePayback({
      saveFen,
      cardPriceFen,
      weeklyFrequency: weekly,
      orderSampleSize: sample,
      eligibleCount: draft.eligibleCount,
      saveSource,
      cardPriceSource,
      frequencySource,
      cardLabel: cardLabelFromDiscount(draft.discountType),
    });
    draft.paybackLines = result.lines;
    return { card: this.pricedCard(draft) };
  }

  private chooseTakeWay(draft: Draft, code: string | undefined): FlowResult {
    if (code && draft.quote?.takeWays.some((way) => way.code === code)) draft.takeWayCode = code;
    return { card: this.pricedCard(draft) };
  }

  private async quoteDraft(draft: Draft, trigger: Trigger): Promise<FlowResult> {
    const envelope = await this.mcp.call(
      "calculate-price",
      {
        ...pickupBase(draft.storeCode),
        needTableware: draft.needTableware,
        items: draft.items.map((item) => ({ productCode: item.productCode, quantity: item.quantity })),
      },
      trigger,
    );
    if (!envelope.success) return { text: explainMcpFailure(envelope) };
    const quote = readPriceQuote(envelope.data);
    if (!quote) return { text: "核价结果不完整" };
    draft.quote = quote;
    draft.quotedAt = this.options.now();
    draft.status = "priced";
    if (!quote.takeWays.some((way) => way.code === draft.takeWayCode)) {
      draft.takeWayCode = quote.takeWays[0]?.code ?? "eat-in";
    }
    for (const line of quote.lines) {
      const item = draft.items.find((candidate) => candidate.productCode === line.productCode);
      if (item && !item.name) item.name = line.productName;
    }
    this.rememberPrice(quote.priceFen);
    return { card: this.pricedCard(draft) };
  }

  private newDraft(input: IncomingMessage, storeCode: string, storeName: string, items: OrderItem[]): Draft {
    const draft: Draft = {
      id: `d-${input.eventId}`,
      chatId: input.chatId,
      storeCode,
      storeName,
      items: [],
      takeWayCode: "eat-in",
      needTableware: false,
      status: "priced",
      eligibleCount: 0,
      paybackLines: null,
      pending: false,
      comboDefault: false,
    };
    this.applyItems(draft, items);
    this.sessions.put(draft);
    return draft;
  }

  private applyItems(draft: Draft, items: OrderItem[]): void {
    draft.items = items;
    const found = eligibleWithOrder(items);
    draft.eligibleCount = found.count;
    draft.withOrder = found.withOrder;
    draft.discountType = found.discountType;
    draft.comboDefault = isCombo(items);
    draft.paybackLines = null;
  }

  private refreshEligibility(draft: Draft): void {
    for (const item of draft.items) {
      const meal = this.menu.get(item.productCode);
      if (!meal) continue;
      item.name ??= meal.name;
      item.canWithOrder = meal.canWithOrder;
      item.discountType = meal.discountType;
      item.withOrder = meal.withOrder;
      item.originalPriceYuan = meal.originalPrice;
      item.memberPriceYuan = meal.currentPrice;
    }
    const found = eligibleWithOrder(draft.items);
    draft.eligibleCount = found.count;
    draft.withOrder = found.withOrder;
    draft.discountType = found.discountType;
  }

  private rememberMeals(envelope: BusinessEnvelope): MealInfo | undefined {
    const parsed = parseMealsPayload(envelope.data);
    for (const meal of parsed.meals) this.menu.set(meal.code, meal);
    if (parsed.frequentCode) return this.menu.get(parsed.frequentCode);
    return parsed.meals[0];
  }

  private nextMeal(draft: Draft): MealInfo | undefined {
    const list = [...this.menu.values()];
    if (list.length === 0) return undefined;
    const codes = new Set(draft.items.map((item) => item.productCode));
    const start = Math.max(0, list.findIndex((meal) => codes.has(meal.code)));
    for (let offset = 1; offset <= list.length; offset += 1) {
      const meal = list[(start + offset) % list.length];
      if (meal && !codes.has(meal.code)) return meal;
    }
    return list[0];
  }

  private mealToItem(meal: MealInfo, quantity: number): OrderItem {
    return {
      productCode: meal.code,
      quantity,
      name: meal.name,
      canWithOrder: meal.canWithOrder,
      discountType: meal.discountType,
      withOrder: meal.withOrder,
      originalPriceYuan: meal.originalPrice,
      memberPriceYuan: meal.currentPrice,
    };
  }

  private quoteExpired(draft: Draft): boolean {
    if (!draft.quotedAt) return true;
    return this.options.now() - draft.quotedAt > QUOTE_TTL_MS;
  }

  private rememberOrder(draft: Draft): void {
    const saved = this.state.load();
    const now = new Date(this.options.now()).toISOString();
    saved.favorite = { savedAt: now, items: draft.items };
    if (draft.quote) {
      saved.lastPrice = { fen: draft.quote.priceFen, savedAt: now, note: "上次价格，确认后实时核价" };
    }
    this.state.save(saved);
  }

  private rememberPrice(fen: number): void {
    const saved = this.state.load();
    saved.lastPrice = {
      fen,
      savedAt: new Date(this.options.now()).toISOString(),
      note: "上次价格，确认后实时核价",
    };
    this.state.save(saved);
  }

  private pricedCard(draft: Draft, staleNote?: string): FeishuCard {
    const quote = draft.quote;
    return buildCard({
      kind: "priced",
      storeName: draft.storeName,
      lines: (quote?.lines ?? draft.items.map<QuoteLine>((item) => ({
        productCode: item.productCode,
        productName: item.name ?? item.productCode,
        quantity: item.quantity,
        subtotalFen: 0,
      }))).map((line) => ({ name: line.productName, quantity: line.quantity, subtotalFen: line.subtotalFen })),
      totalFen: quote?.priceFen ?? 0,
      discountFen: quote?.discountFen ?? 0,
      tablewareFen: quote?.tablewareFen ?? 0,
      takeWays: quote?.takeWays ?? [
        { code: "eat-in", title: "堂食" },
        { code: "locker-out", title: "外带" },
      ],
      selectedTakeWay: draft.takeWayCode,
      needTableware: draft.needTableware,
      sessionId: draft.id,
      comboDefault: draft.comboDefault,
      eligibleCount: draft.eligibleCount,
      paybackLines: draft.paybackLines,
      staleNote,
    });
  }

  private dryRunCard(draft: Draft): FeishuCard {
    const quote = draft.quote!;
    const title = quote.takeWays.find((way) => way.code === draft.takeWayCode)?.title ?? draft.takeWayCode;
    return buildCard({
      kind: "dry-run",
      storeName: draft.storeName,
      lines: quote.lines.map((line) => ({ name: line.productName, quantity: line.quantity, subtotalFen: line.subtotalFen })),
      totalFen: quote.priceFen,
      takeWayTitle: title,
      sessionId: draft.id,
    });
  }

  private payCard(draft: Draft, note?: string): FeishuCard {
    return buildCard({
      kind: "pay",
      sessionId: draft.id,
      orderTail: tail(draft.orderId ?? ""),
      totalFen: draft.realTotalFen ?? draft.quote?.priceFen ?? 0,
      payH5Url: draft.payH5Url ?? "",
      note,
    });
  }

  private cardFor(draft: Draft): FeishuCard {
    if (draft.status === "ordered") return this.payCard(draft);
    return this.pricedCard(draft, this.quoteExpired(draft) ? "核价已过期，请先重新核价。" : undefined);
  }

  private resolveDraft(sessionId: string | undefined): { draft?: Draft; early?: FlowResult } {
    if (!sessionId) return {};
    const existing = this.sessions.get(sessionId);
    if (existing) return { draft: existing };
    const store = this.options.proposals;
    if (!store) return {};
    const proposal = store.getProposal(sessionId);
    if (!proposal) return {};
    if (proposal.status === "confirmed") {
      return { early: { toast: { type: "info", content: "这份提议已经确认过了" } } };
    }
    if (proposal.status === "dismissed") {
      return { early: { toast: { type: "info", content: "这份提议已经放下了" } } };
    }
    if (this.options.now() - proposal.quote.quotedAt > QUOTE_TTL_MS) {
      return {
        early: {
          toast: { type: "error", content: "报价已过期，请让助手重新核价" },
          text: "报价已过期，请让助手重新核价",
        },
      };
    }
    const draft = this.draftFromProposal(proposal);
    this.sessions.put(draft);
    return { draft };
  }

  private draftFromProposal(proposal: AgentProposal): Draft {
    const quote = proposal.quote;
    const draft: Draft = {
      id: proposal.id,
      chatId: "agent",
      storeCode: quote.storeCode,
      storeName: quote.storeName,
      items: [],
      takeWayCode: quote.takeWayCode,
      needTableware: quote.needTableware,
      quote: {
        priceFen: quote.priceFen,
        discountFen: quote.discountFen,
        tablewareFen: quote.tablewareFen,
        lines: quote.lines.map((line) => ({
          productCode: line.productCode,
          productName: line.productName,
          quantity: line.quantity,
          subtotalFen: line.subtotalFen,
        })),
        takeWays: quote.takeWays.map((way) => ({ code: way.code, title: way.title })),
      },
      quotedAt: quote.quotedAt,
      status: "priced",
      eligibleCount: 0,
      paybackLines: null,
      pending: false,
      comboDefault: false,
    };
    this.applyItems(
      draft,
      quote.items.map((item) => ({
        productCode: item.productCode,
        quantity: item.quantity,
        name: item.name,
      })),
    );
    return draft;
  }

  private syncProposal(draft: Draft): void {
    const store = this.options.proposals;
    if (!store) return;
    const proposal = store.getProposal(draft.id);
    if (!proposal || proposal.status !== "pending") return;
    if (draft.status === "ordered") store.updateStatus(draft.id, "confirmed");
    else if (draft.status === "cancelled") store.updateStatus(draft.id, "dismissed");
  }

  /** 群拼单把已经核好价的草稿交给原来的确认流程。守卫、演练模式和幂等都不变。 */
  async submitPricedDraft(input: CardInput, draft: Draft): Promise<FlowResult> {
    if (input.operatorOpenId !== this.options.ownerOpenId) {
      return { toast: { type: "warning", content: NOT_OWNER } };
    }
    const existing = this.sessions.get(draft.id);
    const target = existing?.status === "ordered" ? existing : draft;
    if (target.pending) return { toast: { type: "info", content: "正在处理，请稍候" } };
    this.sessions.put(target);
    target.pending = true;
    try {
      const result = await this.confirm(input, target);
      this.syncProposal(target);
      return result;
    } finally {
      target.pending = false;
    }
  }

  draftOf(sessionId: string): Draft | undefined {
    return this.sessions.get(sessionId);
  }

  private trigger(kind: Trigger["kind"], eventId: string, operatorOpenId: string, action: ActionName): Trigger {
    return { kind, eventId, operatorOpenId, action };
  }

  private fail(error: unknown): FlowResult {
    if (error instanceof GuardError) {
      const content = error.code === "NOT_OWNER" ? NOT_OWNER : error.message;
      return { toast: { type: "error", content }, text: content };
    }
    const message = redact(error instanceof Error ? error.message : "处理失败");
    return { text: message, toast: { type: "error", content: message } };
  }
}

function pickupBase(storeCode: string): Record<string, unknown> {
  return { storeCode, orderType: PICKUP_ORDER_TYPE, beType: PICKUP_BE_TYPE };
}

function tail(orderId: string): string {
  if (orderId.length <= 4) return orderId;
  return `…${orderId.slice(-4)}`;
}

function readStores(data: unknown): { storeCode: string; storeName: string }[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.storeCode !== "string" || typeof record.storeName !== "string") return [];
    return [{ storeCode: record.storeCode, storeName: record.storeName }];
  });
}

interface HistoryProduct {
  productCode: string;
  productName: string;
  quantity: number;
}

interface HistoryOrder {
  orderStatus: string;
  createTime: string;
  products: HistoryProduct[];
}

function readHistory(data: unknown): HistoryOrder[] {
  const list = data && typeof data === "object" && Array.isArray((data as { list?: unknown }).list)
    ? (data as { list: unknown[] }).list
    : [];
  return list.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const products = Array.isArray(record.orderProductList)
      ? record.orderProductList.flatMap((product) => {
          if (!product || typeof product !== "object") return [];
          const row = product as Record<string, unknown>;
          if (typeof row.productCode !== "string") return [];
          return [
            {
              productCode: row.productCode,
              productName: typeof row.productName === "string" ? row.productName : row.productCode,
              quantity: typeof row.quantity === "number" ? row.quantity : 1,
            },
          ];
        })
      : [];
    return [
      {
        orderStatus: typeof record.orderStatus === "string" ? record.orderStatus : "",
        createTime: typeof record.createTime === "string" ? record.createTime : "",
        products,
      },
    ];
  });
}

function readCreated(data: unknown): { orderId: string; payH5Url: string; totalFen: number } | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (typeof record.orderId !== "string" || typeof record.payH5Url !== "string") return null;
  const detail = record.orderDetail;
  const amount = detail && typeof detail === "object" ? (detail as { realTotalAmount?: unknown }).realTotalAmount : undefined;
  return { orderId: record.orderId, payH5Url: record.payH5Url, totalFen: yuanToFen(amount, 0) };
}

function readOrderDetail(data: unknown, fallbackFen: number): { orderStatus: string; pickupCode: string; lockerCode?: string; totalFen: number } {
  if (!data || typeof data !== "object") {
    return { orderStatus: "", pickupCode: "", totalFen: fallbackFen };
  }
  const record = data as Record<string, unknown>;
  return {
    orderStatus: typeof record.orderStatus === "string" ? record.orderStatus : "",
    pickupCode: typeof record.pickupCode === "string" ? record.pickupCode : "",
    lockerCode: typeof record.lockerCode === "string" ? record.lockerCode : undefined,
    totalFen: yuanToFen(record.realTotalAmount, fallbackFen),
  };
}

function yuanToFen(value: unknown, fallback: number): number {
  if (typeof value === "number") {
    try {
      return yuanStringToFen(String(value));
    } catch {
      return fallback;
    }
  }
  if (typeof value === "string" && value.trim()) {
    try {
      return yuanStringToFen(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function readManualPrice(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  try {
    return yuanStringToFen(value.trim());
  } catch {
    return null;
  }
}

function referenceSave(items: OrderItem[]): number {
  let save = 0;
  for (const item of items) {
    if (!item.canWithOrder || !item.originalPriceYuan || !item.memberPriceYuan) continue;
    if (!item.discountType?.startsWith("随单购")) continue;
    save += (yuanStringToFen(item.originalPriceYuan) - yuanStringToFen(item.memberPriceYuan)) * item.quantity;
  }
  return save;
}
