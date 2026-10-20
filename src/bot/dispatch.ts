import type { FeishuCard } from "../cards/types.js";
import { redact } from "../core/parse.js";
import type { GroupFlow } from "./group-flow.js";
import type { CardInput, IncomingMessage, OrderFlow } from "./flow.js";

export interface Outbound {
  sendCard(chatId: string, card: FeishuCard): Promise<string | void>;
  sendText(chatId: string, text: string): Promise<void>;
  patchCard(messageId: string, card: FeishuCard): Promise<void>;
  sendDirectCard(openId: string, card: FeishuCard): Promise<void>;
}

export interface Runtime {
  flow: OrderFlow;
  outbound: Outbound;
  ownerOpenId: string;
  group?: GroupFlow;
}

export interface CardAck {
  toast: { type: "info" | "success" | "warning" | "error"; content: string };
}

/**
 * 长连接要求 3 秒内结束回调。这里同步返回 toast，MCP 和更新卡片都放在后面。
 */
export function handleCardCallback(raw: unknown, runtime: Runtime): CardAck {
  const event = parseCardEvent(raw);
  if (!event) return { toast: { type: "error", content: "没有读懂这次点击" } };
  const memberVote = event.action === "group.tick" || event.action === "group.drop";
  if (!memberVote && event.operatorOpenId !== runtime.ownerOpenId) {
    return { toast: { type: "warning", content: "只有发起人可以核价和下单" } };
  }
  if (event.action.startsWith("group.") && !runtime.group) {
    return { toast: { type: "error", content: "群拼单没有就绪" } };
  }
  const grouped =
    Boolean(runtime.group) &&
    (event.action.startsWith("group.") || (runtime.group?.owns(event.sessionId) === true && event.action === "order.refresh"));
  const task = grouped && runtime.group ? runtime.group.onCard(event) : runtime.flow.onCard(event);
  void task
    .then(async (result) => {
      if (result.direct) await runtime.outbound.sendDirectCard(result.direct.openId, result.direct.card);
      if (result.groupPatch) await runtime.outbound.patchCard(result.groupPatch.messageId, result.groupPatch.card);
      if (result.card && event.messageId) await runtime.outbound.patchCard(event.messageId, result.card);
      else if (result.text && event.chatId) await runtime.outbound.sendText(event.chatId, result.text);
    })
    .catch((error: unknown) => {
      const message = redact(error instanceof Error ? error.message : "处理失败");
      if (event.chatId) void runtime.outbound.sendText(event.chatId, message);
    });
  return { toast: { type: "info", content: toastFor(event.action) } };
}

export function handleIncomingMessage(raw: unknown, runtime: Runtime): void {
  const message = parseMessageEvent(raw);
  if (!message) return;
  const task = message.chatType === "group" && runtime.group ? runtime.group.onMessage(message) : runtime.flow.onMessage(message);
  void task
    .then(async (result) => {
      if (result.card) {
        const messageId = await runtime.outbound.sendCard(message.chatId, result.card);
        if (result.sessionId && typeof messageId === "string") runtime.group?.noteMessage(result.sessionId, messageId);
      } else if (result.text) await runtime.outbound.sendText(message.chatId, result.text);
      if (result.direct) await runtime.outbound.sendDirectCard(result.direct.openId, result.direct.card);
    })
    .catch((error: unknown) => {
      const text = redact(error instanceof Error ? error.message : "处理失败");
      void runtime.outbound.sendText(message.chatId, text);
    });
}

function toastFor(action: string): string {
  switch (action) {
    case "order.confirm":
      return "下单中…";
    case "order.refresh":
      return "正在刷新…";
    case "order.cancel.confirm":
      return "正在取消…";
    case "payback.calc":
      return "计算中…";
    case "group.close":
      return "核价中…";
    case "group.confirm":
      return "下单中…";
    case "group.tick":
    case "group.drop":
      return "处理中…";
    default:
      return "处理中…";
  }
}

export function parseMessageEvent(raw: unknown): IncomingMessage | undefined {
  const event = unwrap(raw);
  if (!event) return undefined;
  const message = event.message;
  const sender = event.sender;
  if (!message || typeof message !== "object" || !sender || typeof sender !== "object") return undefined;
  const body = message as Record<string, unknown>;
  const senderId = (sender as { sender_id?: { open_id?: string } }).sender_id;
  const openId = senderId?.open_id;
  if (typeof body.message_id !== "string" || typeof body.chat_id !== "string" || !openId) return undefined;
  if (body.message_type !== "text" || typeof body.content !== "string") return undefined;
  const chatType = body.chat_type === "group" ? "group" : "p2p";
  return {
    eventId: body.message_id,
    openId,
    chatId: body.chat_id,
    chatType,
    text: textOf(body.content),
  };
}

let clickSeq = 0;

export function parseCardEvent(raw: unknown): CardInput | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const root = raw as Record<string, unknown>;
  const header = root.header && typeof root.header === "object" ? (root.header as { event_id?: string }) : undefined;
  const event = unwrap(raw);
  if (!event) return undefined;
  const operator = event.operator as { open_id?: string; name?: string } | undefined;
  const action = event.action as Record<string, unknown> | undefined;
  if (!operator?.open_id || !action) return undefined;
  const value = action.value && typeof action.value === "object" ? (action.value as Record<string, unknown>) : {};
  const name = typeof action.name === "string" ? action.name : undefined;
  const actionName = typeof value.a === "string" ? value.a : name;
  if (!actionName) return undefined;
  const context = event.context as { open_message_id?: string; open_chat_id?: string } | undefined;
  const formValue = action.form_value && typeof action.form_value === "object" ? (action.form_value as Record<string, unknown>) : {};
  const form: Record<string, string> = {};
  for (const [key, item] of Object.entries(formValue)) {
    if (typeof item === "string") form[key] = item;
  }
  clickSeq += 1;
  return {
    eventId: header?.event_id ?? `click-${clickSeq}`,
    operatorOpenId: operator.open_id,
    messageId: context?.open_message_id,
    chatId: context?.open_chat_id,
    action: actionName,
    sessionId: typeof value.sid === "string" ? value.sid : undefined,
    takeWay: typeof value.takeWay === "string" ? value.takeWay : undefined,
    storeCode: typeof value.storeCode === "string" ? value.storeCode : undefined,
    storeName: typeof value.storeName === "string" ? value.storeName : undefined,
    productCode: typeof value.code === "string" ? value.code : undefined,
    delta: typeof value.delta === "number" ? value.delta : undefined,
    scene: typeof value.scene === "string" ? value.scene : undefined,
    operatorName: typeof operator.name === "string" ? operator.name : undefined,
    form,
  };
}

function unwrap(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (record.event && typeof record.event === "object") return record.event as Record<string, unknown>;
  return record;
}

function textOf(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return (parsed.text ?? "").replace(/@_user_\d+/g, "").trim();
  } catch {
    return content.trim();
  }
}
