import {
  ACTION_CALL_BUDGET,
  ENABLED_TOOLS,
  REFRESH_COOLDOWN_MS,
  REJECTED_WRITE_TOOLS,
  type ActionName,
  type GuardMeta,
  type Trigger,
} from "./types.js";

export class GuardError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GuardError";
    this.code = code;
  }
}

export interface GuardTicket {
  writeKey?: string;
}

/**
 * 每一次 MCP 调用都要能追溯到 Token 主人当场的一次操作。
 * 写操作只有 create-order 和 cancel-order，并且 DRY_RUN 时不会发出。
 */
export class McpGuard {
  private readonly used = new Map<string, number>();
  private readonly inflight = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly refreshedAt = new Map<string, number>();

  constructor(
    private readonly options: {
      ownerOpenId: string;
      dryRun: boolean;
    },
  ) {}

  get dryRun(): boolean {
    return this.options.dryRun;
  }

  usedCount(eventId: string): number {
    return this.used.get(eventId) ?? 0;
  }

  begin(tool: string, trigger: Trigger | undefined, meta: GuardMeta = {}): GuardTicket {
    if (!trigger?.eventId || !trigger.operatorOpenId || !trigger.action || !trigger.kind) {
      throw new GuardError("NO_TRIGGER", "缺少用户触发，拒绝调用 MCP");
    }
    if (!this.options.ownerOpenId || trigger.operatorOpenId !== this.options.ownerOpenId) {
      throw new GuardError("NOT_OWNER", "只有发起人可以核价和下单");
    }
    if ((REJECTED_WRITE_TOOLS as readonly string[]).includes(tool) || !(ENABLED_TOOLS as readonly string[]).includes(tool)) {
      throw new GuardError("TOOL_DISABLED", "这个工具不在白名单里");
    }
    if (trigger.kind === "agent") this.assertAgent(tool);

    const action = trigger.action;
    if (!(action in ACTION_CALL_BUDGET)) {
      throw new GuardError("UNKNOWN_ACTION", "未知操作，拒绝调用 MCP");
    }
    const budget = ACTION_CALL_BUDGET[action as ActionName];
    const used = this.used.get(trigger.eventId) ?? 0;
    if (used >= budget) {
      throw new GuardError("BUDGET", "这一步的请求次数到上限了");
    }

    const ticket: GuardTicket = {};
    if (tool === "create-order" || tool === "cancel-order") {
      this.assertWrite(tool, trigger, meta, ticket);
    }
    if (tool === "query-order") {
      this.assertRefresh(meta);
    }

    this.used.set(trigger.eventId, used + 1);
    if (ticket.writeKey) this.inflight.add(ticket.writeKey);
    if (tool === "query-order" && meta.orderId) {
      this.refreshedAt.set(meta.orderId, meta.now ?? Date.now());
    }
    return ticket;
  }

  finish(ticket: GuardTicket, delivered: boolean): void {
    if (!ticket.writeKey) return;
    this.inflight.delete(ticket.writeKey);
    if (delivered) this.completed.add(ticket.writeKey);
  }

  /** Agent 入口只能查询。下单和取消仍必须由飞书卡片点击触发。 */
  private assertAgent(tool: string): void {
    if (tool === "create-order" || tool === "cancel-order") {
      throw new GuardError("TOOL_DISABLED", "Agent 入口不能下单或取消订单");
    }
  }

  private assertWrite(tool: string, trigger: Trigger, meta: GuardMeta, ticket: GuardTicket): void {
    if (trigger.kind !== "card") {
      throw new GuardError("WRITE_NEEDS_CLICK", "下单和取消只能来自卡片点击");
    }
    if (this.options.dryRun) {
      throw new GuardError("DRY_RUN", "演练模式不会发出写操作");
    }
    if (tool === "create-order") {
      if (trigger.action !== "confirm") {
        throw new GuardError("WRITE_ACTION", "create-order 只能由确认下单触发");
      }
      if (!meta.draftId || meta.draftStatus !== "priced") {
        throw new GuardError("DRAFT_STATE", "只有已核价且未下单的草稿可以下单");
      }
      ticket.writeKey = `create:${meta.draftId}`;
    } else {
      if (trigger.action !== "cancel") {
        throw new GuardError("WRITE_ACTION", "cancel-order 只能由确认取消触发");
      }
      if (!meta.orderId) {
        throw new GuardError("DRAFT_STATE", "取消订单需要订单号");
      }
      ticket.writeKey = `cancel:${meta.orderId}`;
    }
    if (this.completed.has(ticket.writeKey)) {
      throw new GuardError("ALREADY_DONE", "这个操作已经完成，不会重复提交");
    }
    if (this.inflight.has(ticket.writeKey)) {
      throw new GuardError("IN_FLIGHT", "这个操作正在处理");
    }
  }

  private assertRefresh(meta: GuardMeta): void {
    if (!meta.orderId) {
      throw new GuardError("DRAFT_STATE", "刷新订单需要订单号");
    }
    const now = meta.now ?? Date.now();
    const previous = this.refreshedAt.get(meta.orderId);
    if (previous !== undefined && now - previous < REFRESH_COOLDOWN_MS) {
      throw new GuardError("COOLDOWN", "请等几秒再刷新");
    }
  }
}
