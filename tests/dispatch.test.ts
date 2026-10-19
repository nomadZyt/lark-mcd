import { describe, expect, it } from "vitest";
import type { FeishuCard } from "../src/cards/types.js";
import { handleCardCallback, handleIncomingMessage, type Outbound } from "../src/bot/dispatch.js";
import { calls, setup } from "./helpers.js";

class MemoryOutbound implements Outbound {
  texts: string[] = [];
  patched: FeishuCard[] = [];
  sent: FeishuCard[] = [];

  async sendCard(_chatId: string, card: FeishuCard): Promise<void> {
    this.sent.push(card);
  }

  async sendText(_chatId: string, text: string): Promise<void> {
    this.texts.push(text);
  }

  async patchCard(_messageId: string, card: FeishuCard): Promise<void> {
    this.patched.push(card);
  }
}

describe("卡片回调", () => {
  it("确认回调在下单完成前就返回 toast", async () => {
    const { flow, mcp, owner } = setup({ dryRun: false });
    await flow.onMessage({
      eventId: "msg-1",
      openId: owner,
      chatId: "chat-1",
      chatType: "p2p",
      text: "老样子",
    });
    let release: () => void = () => {};
    mcp.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const outbound = new MemoryOutbound();
    const ack = handleCardCallback(cardEvent("order.confirm"), { flow, outbound, ownerOpenId: owner });
    expect(ack.toast.content).toBe("下单中…");
    expect(calls(mcp, "create-order")).toBe(0);
    expect(outbound.patched).toHaveLength(0);
    release();
    await waitFor(() => outbound.patched.length === 1);
    expect(calls(mcp, "create-order")).toBe(1);
    const create = mcp.calls.find((call) => call.tool === "create-order");
    expect(create?.args).not.toHaveProperty("withOrder");
  });

  it("确认下单的回调在核价之后返回 toast，再异步更新卡片", async () => {
    const { flow, mcp, owner } = setup({ dryRun: true });
    await flow.onMessage({
      eventId: "msg-1",
      openId: owner,
      chatId: "chat-1",
      chatType: "p2p",
      text: "老样子",
    });
    let release: () => void = () => {};
    mcp.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const outbound = new MemoryOutbound();
    const ack = handleCardCallback(cardEvent("payback.calc", { card_price: "19.9", freq: "3" }), {
      flow,
      outbound,
      ownerOpenId: owner,
    });
    expect(ack.toast.content).toBe("计算中…");
    expect(outbound.patched).toHaveLength(0);
    expect(calls(mcp, "calculate-price")).toBe(1);
    release();
    await waitFor(() => outbound.patched.length === 1);
    expect(calls(mcp, "create-order")).toBe(0);
  });

  it("别人点按钮时 toast 拒绝，并且不调用 MCP", async () => {
    const { flow, mcp, owner } = setup();
    const before = mcp.calls.length;
    const ack = handleCardCallback(
      {
        operator: { open_id: "other" },
        action: { value: { a: "order.confirm", sid: "d-msg-1", v: 1 } },
        context: { open_message_id: "om_1", open_chat_id: "oc_1" },
      },
      { flow, outbound: new MemoryOutbound(), ownerOpenId: owner },
    );
    expect(ack.toast.content).toContain("只有发起人");
    await Promise.resolve();
    expect(mcp.calls.length).toBe(before);
  });

  it("私聊消息异步回卡片", async () => {
    const { flow, owner } = setup();
    const outbound = new MemoryOutbound();
    handleIncomingMessage(
      {
        sender: { sender_id: { open_id: owner } },
        message: {
          message_id: "om_1",
          chat_id: "oc_1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "老样子" }),
        },
      },
      { flow, outbound, ownerOpenId: owner },
    );
    await waitFor(() => outbound.sent.length === 1);
    expect(outbound.sent[0]?.header.title.content).toContain("老样子");
  });
});

function cardEvent(action: string, form: Record<string, string> = {}) {
  return {
    operator: { open_id: "owner" },
    action: { value: { a: action, sid: "d-msg-1", v: 1 }, form_value: form },
    context: { open_message_id: "om_card", open_chat_id: "oc_1" },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("等待超时");
}
