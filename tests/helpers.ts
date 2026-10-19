import { McpGuard } from "../src/core/guard.js";
import { loadFixtures, MockMcpClient } from "../src/core/mock-mcp.js";
import { OrderFlow, type CardInput, type IncomingMessage } from "../src/bot/flow.js";
import { SessionBook } from "../src/bot/session.js";
import { loadDemoState, MemoryStateStore, type AppState } from "../src/bot/state.js";

export function setup(options?: {
  dryRun?: boolean;
  owner?: string;
  now?: () => number;
  state?: AppState;
}) {
  const owner = options?.owner ?? "owner";
  const dryRun = options?.dryRun ?? true;
  const guard = new McpGuard({ ownerOpenId: owner, dryRun });
  const mcp = new MockMcpClient(guard, loadFixtures());
  const state = new MemoryStateStore(options?.state ?? { ...loadDemoState() });
  const flow = new OrderFlow(mcp, state, new SessionBook(), {
    ownerOpenId: owner,
    dryRun,
    now: options?.now ?? (() => Date.parse("2026-10-19T12:00:00+08:00")),
  });
  return { guard, mcp, state, flow, owner };
}

export function message(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    eventId: "msg-1",
    openId: "owner",
    chatId: "chat-1",
    chatType: "p2p",
    text: "老样子",
    ...over,
  };
}

export function card(over: Partial<CardInput> = {}): CardInput {
  return {
    eventId: "card-1",
    operatorOpenId: "owner",
    action: "order.confirm",
    sessionId: "d-msg-1",
    form: {},
    ...over,
  };
}

export function calls(mcp: MockMcpClient, tool: string): number {
  return mcp.calls.filter((call) => call.tool === tool).length;
}
