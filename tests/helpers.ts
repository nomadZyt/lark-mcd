import { McpGuard } from "../src/core/guard.js";
import { loadFixtures, MockMcpClient } from "../src/core/mock-mcp.js";
import { OrderFlow, type CardInput, type IncomingMessage } from "../src/bot/flow.js";
import { GroupFlow } from "../src/bot/group-flow.js";
import { MemoryLedger } from "../src/bot/ledger.js";
import { SessionBook } from "../src/bot/session.js";
import { loadDemoState, MemoryStateStore, type AppState } from "../src/bot/state.js";
import type { ProposalStore } from "../src/agent/proposal-store.js";

export function setup(options?: {
  dryRun?: boolean;
  owner?: string;
  now?: () => number;
  state?: AppState;
  proposals?: ProposalStore;
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
    proposals: options?.proposals,
  });
  return { guard, mcp, state, flow, owner };
}

export function setupGroup(options?: { dryRun?: boolean; owner?: string; now?: () => number }) {
  const base = setup(options);
  const ledger = new MemoryLedger();
  const group = new GroupFlow(base.mcp, base.state, ledger, base.flow, {
    ownerOpenId: base.owner,
    now: options?.now ?? (() => Date.parse("2026-10-19T12:00:00+08:00")),
  });
  return { ...base, ledger, group };
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
