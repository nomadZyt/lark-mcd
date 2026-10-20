import type { FeishuCard } from "../cards/types.js";
import { buildCard, cardHasPaymentLink } from "../cards/build.js";
import { splitOrderFen, type PersonShare } from "../core/aa.js";
import { GuardError } from "../core/guard.js";
import {
  GROUP_HELP_TEXT,
  GROUP_PORTION_CAP,
  GROUP_SCENES,
  aggregateItems,
  applyTick,
  displayNameFromOpenId,
  dropLines,
  formatSignup,
  isGroupScene,
  parseGroupCommand,
  pickCandidates,
  totalPortions,
  type GroupScene,
  type GroupVote,
} from "../core/group-vote.js";
import type { McpClient } from "../core/mcp-client.js";
import { parseMealsPayload, explainMcpFailure, redact } from "../core/parse.js";
import { readPriceQuote } from "./quote.js";
import { PICKUP_BE_TYPE, PICKUP_ORDER_TYPE, QUOTE_TTL_MS, type MealInfo, type Trigger } from "../core/types.js";
import { formatYuanFromFen } from "../core/money.js";
import type { OrderFlow, CardInput, FlowResult, IncomingMessage } from "./flow.js";
import { buildLedgerRows, clipOrderTail, scrubLedgerText, type LedgerWriter } from "./ledger.js";
import type { Draft, PriceQuote } from "./session.js";
import type { StateStore } from "./state.js";

const MENU_TTL_MS = 10 * 60 * 1000;
const NOT_OWNER = "只有发起人可以核价和下单";

interface LiveVote extends GroupVote {
  takeWayCode: string;
  quote?: PriceQuote;
  quotedAt?: number;
  orderTail?: string;
  orderFen?: number;
  payStatus?: string;
  ledgerWritten: boolean;
  ledgerNote?: string;
  groupMessageId?: string;
  pending: boolean;
  names: Map<string, string>;
}

/**
 * 群投票拼单。成员勾选只改本地份数。
 * 截止核价和确认下单只允许 Token 主人，确认下单走 OrderFlow 里原有的守卫。
 * 付款链接只放进发起人的私聊。
 */
export class GroupFlow {
  private readonly votes = new Map<string, LiveVote>();
  private readonly byChat = new Map<string, string>();
  private menuCache: { storeCode: string; at: number; meals: MealInfo[] } | undefined;

  constructor(
    private readonly mcp: McpClient,
    private readonly state: StateStore,
    private readonly ledger: LedgerWriter,
    private readonly orders: OrderFlow,
    private readonly options: { ownerOpenId: string; now: () => number },
  ) {}

  owns(sessionId: string | undefined): boolean {
    return Boolean(sessionId && this.votes.has(sessionId));
  }

  noteMessage(sessionId: string, messageId: string): void {
    const vote = this.votes.get(sessionId);
    if (vote && messageId) vote.groupMessageId = messageId;
  }

  async onMessage(input: IncomingMessage): Promise<FlowResult> {
    try {
      const parsed = parseGroupCommand(input.text);
      if (!parsed) return { text: GROUP_HELP_TEXT };
      if (input.openId !== this.options.ownerOpenId) {
        return { text: "只有发起人可以发起拼单、核价和下单。" };
      }
      if (parsed.type === "incomplete") {
        return { text: "请带上时段，例如：/麦麦 拼单 午饭 12:00" };
      }
      const active = this.activeVote(input.chatId);
      if (active) {
        return {
          text: `这一群已经有一场拼单（${active.storeName}，${active.slot}）。请先截止或取消。一场只对应一家店、一个时段。`,
        };
      }
      const saved = this.state.load();
      if (!saved.store?.storeCode || !saved.store.storeName) {
        return { text: "还没有默认门店。请发起人先私聊我：/麦麦 门店 城市 关键词" };
      }
      const meals = await this.mealsFor(saved.store.storeCode, input);
      const candidates = pickCandidates(meals);
      if (candidates.length < 6) return { text: "候选餐品不够，这场拼单先不开。" };
      const vote: LiveVote = {
        id: `g-${input.eventId}`,
        chatId: input.chatId,
        ownerOpenId: input.openId,
        storeCode: saved.store.storeCode,
        storeName: saved.store.storeName,
        scene: parsed.scene,
        slot: parsed.slot,
        candidates,
        lines: [],
        status: "open",
        takeWayCode: "eat-in",
        ledgerWritten: false,
        pending: false,
        names: new Map([[input.openId, "发起人"]]),
      };
      this.votes.set(vote.id, vote);
      this.byChat.set(input.chatId, vote.id);
      return { card: this.voteCard(vote), sessionId: vote.id };
    } catch (error) {
      return this.fail(error);
    }
  }

  async onCard(input: CardInput): Promise<FlowResult> {
    try {
      const vote = input.sessionId ? this.votes.get(input.sessionId) : undefined;
      if (!vote || vote.status === "cancelled") {
        return { toast: { type: "error", content: "这场拼单已经结束" } };
      }
      if (input.action.startsWith("group.") && input.messageId) vote.groupMessageId = input.messageId;
      if (input.operatorName) vote.names.set(input.operatorOpenId, displayNameFromOpenId(input.operatorOpenId, input.operatorName));
      if (vote.pending) return { toast: { type: "info", content: "正在处理，请稍候" } };

      if (input.action === "group.tick" || input.action === "group.drop") {
        return this.tick(vote, input);
      }
      if (input.operatorOpenId !== this.options.ownerOpenId) {
        return { toast: { type: "warning", content: NOT_OWNER } };
      }
      switch (input.action) {
        case "group.close":
          return await this.close(vote, input);
        case "group.confirm":
          return await this.confirm(vote, input);
        case "group.cancel":
          return this.cancel(vote);
        case "group.back":
          return this.back(vote);
        case "group.scene":
          return this.scene(vote, input.scene);
        case "group.takeway":
          return this.takeWay(vote, input.takeWay);
        case "group.refresh":
        case "order.refresh":
          return await this.refresh(vote, input);
        default:
          return { toast: { type: "warning", content: "这个按钮没有对应的操作" } };
      }
    } catch (error) {
      return this.fail(error);
    }
  }

  private tick(vote: LiveVote, input: CardInput): FlowResult {
    if (input.action === "group.drop") {
      if (vote.status !== "open") return { toast: { type: "warning", content: "发起人已经截止，不能再改份数" } };
      vote.lines = dropLines(vote.lines, input.operatorOpenId);
      return { card: this.voteCard(vote) };
    }
    const result = applyTick(vote, {
      openId: input.operatorOpenId,
      displayName: displayNameFromOpenId(input.operatorOpenId, input.operatorName ?? vote.names.get(input.operatorOpenId)),
      productCode: input.productCode ?? "",
      delta: input.delta ?? 0,
    });
    if (!result.ok) return { toast: { type: "warning", content: result.reason }, text: result.reason };
    vote.lines = result.lines;
    vote.names.set(
      input.operatorOpenId,
      displayNameFromOpenId(input.operatorOpenId, input.operatorName ?? vote.names.get(input.operatorOpenId)),
    );
    return { card: this.voteCard(vote) };
  }

  private async close(vote: LiveVote, input: CardInput): Promise<FlowResult> {
    if (vote.status !== "open") return { toast: { type: "info", content: "这场拼单已经截止" }, card: this.cardFor(vote) };
    if (totalPortions(vote.lines) === 0) return { toast: { type: "warning", content: "还没有人勾选餐品" } };
    vote.pending = true;
    try {
      const trigger: Trigger = { kind: "card", eventId: input.eventId, operatorOpenId: input.operatorOpenId, action: "group.close" };
      const items = aggregateItems(vote);
      const envelope = await this.mcp.call(
        "calculate-price",
        {
          storeCode: vote.storeCode,
          orderType: PICKUP_ORDER_TYPE,
          beType: PICKUP_BE_TYPE,
          needTableware: false,
          items: items.map((item) => ({ productCode: item.productCode, quantity: item.quantity })),
        },
        trigger,
      );
      if (!envelope.success) return { text: explainMcpFailure(envelope), card: this.voteCard(vote) };
      const quote = readPriceQuote(envelope.data);
      if (!quote) return { text: "核价结果不完整", card: this.voteCard(vote) };
      vote.quote = quote;
      vote.quotedAt = this.options.now();
      vote.status = "priced";
      if (!quote.takeWays.some((way) => way.code === vote.takeWayCode)) {
        vote.takeWayCode = quote.takeWays[0]?.code ?? "eat-in";
      }
      return { card: this.pricedCard(vote) };
    } finally {
      vote.pending = false;
    }
  }

  private async confirm(vote: LiveVote, input: CardInput): Promise<FlowResult> {
    if (vote.status !== "priced" && vote.status !== "rehearsed" && vote.status !== "ordered") {
      return { toast: { type: "warning", content: "请先截止并核价" } };
    }
    if (!vote.quote) return { toast: { type: "warning", content: "请先截止并核价" } };
    if (vote.status === "priced" && this.quoteExpired(vote)) {
      vote.status = "open";
      vote.quote = undefined;
      return { toast: { type: "warning", content: "核价已过期，请重新截止并核价" }, card: this.voteCard(vote) };
    }
    vote.pending = true;
    try {
      const existing = vote.status === "ordered" ? this.orders.draftOf(vote.id) : undefined;
      const draft = existing ?? this.toDraft(vote);
      const placed = await this.orders.submitPricedDraft({ ...input, action: "order.confirm", sessionId: vote.id }, draft);
      if (!placed.card) return placed;
      if (draft.status === "ordered") {
        vote.status = "ordered";
        vote.orderTail = draft.orderId ? clipOrderTail(draft.orderId) : "演练";
        vote.orderFen = draft.realTotalFen ?? vote.quote.priceFen;
        vote.payStatus = "待支付";
      } else if (vote.status !== "ordered") {
        vote.status = "rehearsed";
        vote.orderTail = "演练";
        vote.orderFen = vote.quote.priceFen;
        vote.payStatus = "未下单";
      }
      if (!vote.ledgerWritten) {
        vote.ledgerNote = await this.writeLedger(vote, draft.orderId);
        vote.ledgerWritten = true;
      }
      return {
        card: this.safeGroup(this.statusCard(vote)),
        direct: { openId: vote.ownerOpenId, card: placed.card },
      };
    } finally {
      vote.pending = false;
    }
  }

  private cancel(vote: LiveVote): FlowResult {
    if (vote.status === "ordered") return { toast: { type: "warning", content: "已经下单的拼单不能在这里取消" } };
    vote.status = "cancelled";
    if (this.byChat.get(vote.chatId) === vote.id) this.byChat.delete(vote.chatId);
    return {
      card: buildCard({
        kind: "note",
        title: "这次拼单已取消",
        lines: ["没有下单，也没有收款。想再一起点，就重新 @我 发起。"],
      }),
    };
  }

  private back(vote: LiveVote): FlowResult {
    if (vote.status !== "priced") return { toast: { type: "info", content: "现在不能返回修改" }, card: this.cardFor(vote) };
    vote.status = "open";
    vote.quote = undefined;
    return { card: this.voteCard(vote) };
  }

  private scene(vote: LiveVote, scene: string | undefined): FlowResult {
    if (vote.status !== "priced" || !scene || !isGroupScene(scene)) {
      return { toast: { type: "warning", content: "请先核价，再选事由" }, card: this.cardFor(vote) };
    }
    vote.scene = scene;
    return { card: this.pricedCard(vote) };
  }

  private takeWay(vote: LiveVote, code: string | undefined): FlowResult {
    if (vote.status !== "priced" || !vote.quote || !code) return { card: this.cardFor(vote) };
    if (vote.quote.takeWays.some((way) => way.code === code)) vote.takeWayCode = code;
    return { card: this.pricedCard(vote) };
  }

  private async refresh(vote: LiveVote, input: CardInput): Promise<FlowResult> {
    if (vote.status !== "ordered") return { toast: { type: "info", content: "还没有订单，不用刷新" }, card: this.cardFor(vote) };
    const result = await this.orders.onCard({ ...input, action: "order.refresh", sessionId: vote.id });
    const draft = this.orders.draftOf(vote.id);
    if (draft?.orderStatus) {
      vote.payStatus = scrubLedgerText(draft.orderStatus) || vote.payStatus;
      if (vote.orderTail) await this.ledger.updatePayStatus(vote.orderTail, vote.payStatus ?? "");
      if (typeof draft.realTotalFen === "number") vote.orderFen = draft.realTotalFen;
    }
    const groupCard = this.safeGroup(this.statusCard(vote, { orderStatus: draft?.orderStatus, pickupCode: draft?.pickupCode }));
    const onGroup = !input.messageId || input.messageId === vote.groupMessageId || input.action === "group.refresh";
    if (onGroup) {
      return { card: groupCard, direct: result.card ? { openId: vote.ownerOpenId, card: result.card } : undefined };
    }
    return {
      card: result.card,
      groupPatch: vote.groupMessageId ? { messageId: vote.groupMessageId, card: groupCard } : undefined,
    };
  }

  private async writeLedger(vote: LiveVote, orderId?: string): Promise<string> {
    const shares = this.shares(vote, vote.orderFen ?? vote.quote?.priceFen ?? 0);
    const rows = buildLedgerRows({
      datetime: formatShanghai(this.options.now()),
      storeName: vote.storeName,
      orderId,
      dryRun: vote.status !== "ordered",
      scene: vote.scene,
      shares,
      names: vote.names,
      orderFen: vote.orderFen ?? vote.quote?.priceFen ?? 0,
      payStatus: vote.payStatus ?? "未下单",
    });
    const written = await this.ledger.write(rows);
    if (written.destination === "bitable") return "AA 已写入多维表格。表里没有手机号、地址、取餐码和完整订单号。";
    return "AA 已记在本机台账。没有手机号、地址、取餐码和完整订单号。";
  }

  private shares(vote: LiveVote, orderFen: number): PersonShare[] {
    if (!vote.quote) return [];
    return splitOrderFen({
      portions: vote.lines.map((line) => ({ openId: line.openId, productCode: line.productCode, quantity: line.quantity })),
      products: vote.quote.lines.map((line) => ({
        productCode: line.productCode,
        productName: line.productName,
        quantity: line.quantity,
        subtotalFen: line.subtotalFen,
      })),
      orderFen,
      initiatorOpenId: vote.ownerOpenId,
    });
  }

  private toDraft(vote: LiveVote): Draft {
    const items = aggregateItems(vote);
    return {
      id: vote.id,
      chatId: vote.chatId,
      storeCode: vote.storeCode,
      storeName: vote.storeName,
      items: items.map((item) => ({ productCode: item.productCode, quantity: item.quantity, name: item.name })),
      takeWayCode: vote.takeWayCode,
      needTableware: false,
      quote: vote.quote,
      quotedAt: vote.quotedAt,
      status: "priced",
      eligibleCount: 0,
      paybackLines: null,
      pending: false,
      comboDefault: items.some((item) => item.name.includes("套餐") || item.name.includes("件套") || item.productCode.startsWith("990")),
    };
  }

  private async mealsFor(storeCode: string, input: IncomingMessage): Promise<MealInfo[]> {
    const cached = this.menuCache;
    if (cached && cached.storeCode === storeCode && this.options.now() - cached.at < MENU_TTL_MS) {
      return cached.meals;
    }
    const trigger: Trigger = { kind: "message", eventId: input.eventId, operatorOpenId: input.openId, action: "group.start" };
    const envelope = await this.mcp.call(
      "query-meals",
      { storeCode, orderType: PICKUP_ORDER_TYPE, beType: PICKUP_BE_TYPE },
      trigger,
    );
    if (!envelope.success) throw new Error(explainMcpFailure(envelope));
    const parsed = parseMealsPayload(envelope.data);
    this.menuCache = { storeCode, at: this.options.now(), meals: parsed.meals };
    return parsed.meals;
  }

  private voteCard(vote: LiveVote): FeishuCard {
    const counts = new Map<string, number>();
    for (const line of vote.lines) counts.set(line.productCode, (counts.get(line.productCode) ?? 0) + line.quantity);
    return buildCard({
      kind: "group-vote",
      sessionId: vote.id,
      storeName: vote.storeName,
      scene: vote.scene,
      slot: vote.slot,
      signup: formatSignup(vote),
      cap: GROUP_PORTION_CAP,
      candidates: vote.candidates.map((candidate) => ({
        productCode: candidate.productCode,
        name: candidate.name,
        referenceFen: candidate.referenceFen,
        total: counts.get(candidate.productCode) ?? 0,
      })),
    });
  }

  private pricedCard(vote: LiveVote): FeishuCard {
    const quote = vote.quote!;
    const shares = this.shares(vote, quote.priceFen);
    return buildCard({
      kind: "group-priced",
      sessionId: vote.id,
      storeName: vote.storeName,
      scene: vote.scene,
      scenes: GROUP_SCENES,
      slot: vote.slot,
      totalFen: quote.priceFen,
      discountFen: quote.discountFen,
      tablewareFen: quote.tablewareFen,
      shares: shares.map((share) => ({
        name: vote.names.get(share.openId) ?? displayNameFromOpenId(share.openId),
        shareFen: share.shareFen,
      })),
      takeWays: quote.takeWays,
      selectedTakeWay: vote.takeWayCode,
    });
  }

  private statusCard(vote: LiveVote, detail?: { orderStatus?: string; pickupCode?: string }): FeishuCard {
    const tail = vote.orderTail === "演练" || !vote.orderTail ? "演练" : `…${vote.orderTail}`;
    const ordered = vote.status === "ordered";
    const pickup = detail?.pickupCode?.trim();
    const lines = [
      `${vote.storeName} · ${vote.slot} · ${vote.scene}`,
      ordered ? (pickup ? "发起人已经付款。" : "已下单，待发起人付款。") : "演练模式，没有向麦当劳下单。",
      `订单号 ${tail}`,
      `合计 ${formatYuanFromFen(vote.orderFen ?? vote.quote?.priceFen ?? 0)}`,
      this.shareLine(vote),
      pickup ? `取餐码 ${pickup}` : "",
      detail?.orderStatus ? `状态：${detail.orderStatus}（以麦当劳 App 显示为准）` : "",
      "付款链接只私发给发起人，不会出现在群里。",
      "本工具不收款。发起人自己付款，AA 只记账，大家线下结算。",
      vote.ledgerNote ?? "",
    ].filter(Boolean);
    return buildCard({
      kind: "group-status",
      sessionId: vote.id,
      title: pickup ? `取餐码 ${pickup}` : ordered ? "已下单，待发起人付款" : "演练结束 · 没有下单",
      lines,
      refresh: ordered,
    });
  }

  private shareLine(vote: LiveVote): string {
    if (!vote.quote || vote.orderFen === undefined) return "";
    const shares = this.shares(vote, vote.orderFen);
    if (shares.length === 0) return "";
    return `每人应摊：${shares
      .map((share) => `${vote.names.get(share.openId) ?? displayNameFromOpenId(share.openId)} ${formatYuanFromFen(share.shareFen)}`)
      .join(" · ")}`;
  }

  private cardFor(vote: LiveVote): FeishuCard {
    if (vote.status === "open") return this.voteCard(vote);
    if (vote.status === "priced" && vote.quote) return this.pricedCard(vote);
    return this.statusCard(vote);
  }

  private safeGroup(card: FeishuCard): FeishuCard {
    if (!cardHasPaymentLink(card)) return card;
    return buildCard({
      kind: "note",
      title: "群里不展示付款链接",
      lines: ["付款链接只发给发起人。请查看私聊。本工具不收款。"],
    });
  }

  private activeVote(chatId: string): LiveVote | undefined {
    const id = this.byChat.get(chatId);
    const vote = id ? this.votes.get(id) : undefined;
    if (!vote) return undefined;
    if (vote.status === "open" || vote.status === "priced") return vote;
    return undefined;
  }

  private quoteExpired(vote: LiveVote): boolean {
    if (!vote.quotedAt) return true;
    return this.options.now() - vote.quotedAt > QUOTE_TTL_MS;
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

function formatShanghai(ms: number): string {
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
  return `${formatted.replace(" ", "T")}+08:00`;
}
