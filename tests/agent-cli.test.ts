import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryProposalStore } from "../src/agent/proposal-store.js";
import { AgentError } from "../src/agent/errors.js";
import type { ProposalNotifier } from "../src/agent/feishu-dm.js";
import { executeAgent } from "../src/agent/cli.js";
import { MemoryMenuCache } from "../src/agent/menu-cache.js";
import { FileRateLimiter, MemoryRateLimiter } from "../src/agent/rate-limit.js";
import { collectCardText } from "../src/cards/build.js";
import type { FeishuCard } from "../src/cards/types.js";
import { McpGuard } from "../src/core/guard.js";
import { loadFixtures, MockMcpClient } from "../src/core/mock-mcp.js";
import { QUOTE_TTL_MS } from "../src/core/types.js";
import { calls, card, setup } from "./helpers.js";

const TOKEN = "token-should-not-leak-9f3a";
const SECRET = "secret-should-not-leak";
const NOW = Date.parse("2026-10-19T12:00:00+08:00");

class MemoryNotifier implements ProposalNotifier {
  readonly openIds: string[] = [];
  readonly cards: FeishuCard[] = [];

  async send(openId: string, cardToSend: FeishuCard): Promise<void> {
    this.openIds.push(openId);
    this.cards.push(cardToSend);
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "lark-mcd-agent-"));
}

function envOf(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MCD_MODE: "mock",
    LARK_MCD_AGENT: "1",
    OWNER_OPEN_ID: "owner",
    STATE_PATH: join(dir, "state.json"),
    MCD_MCP_TOKEN: TOKEN,
    FEISHU_APP_SECRET: SECRET,
    ...extra,
  };
}

function mockMcp(): MockMcpClient {
  return new MockMcpClient(new McpGuard({ ownerOpenId: "owner", dryRun: true }), loadFixtures());
}

function jsonOf(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("Agent CLI", () => {
  it("只读命令返回 JSON，并且不带 Token", async () => {
    const dir = tempDir();
    const mcp = mockMcp();
    const limiter = new MemoryRateLimiter();
    const runtime = { env: envOf(dir), mcp, limiter, now: () => NOW };
    const stores = await executeAgent(["agent", "stores", "--near", "上海 人民广场", "--json"], runtime);
    const storesBody = jsonOf(stores.stdout);
    expect(stores.code).toBe(0);
    expect(storesBody).toMatchObject({
      ok: true,
      command: "stores",
      mode: "mock",
      orderPlaced: false,
    });
    expect(storesBody.stores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ storeCode: "DEMO-A", storeName: "演示门店 A" }),
        expect.objectContaining({ storeCode: "DEMO-B" }),
      ]),
    );
    expect(mcp.calls[0]?.args).toMatchObject({ beType: 1, searchType: 2, city: "上海", keyword: "人民广场" });

    const menu = await executeAgent(["agent", "menu", "--store", "DEMO-A", "--json"], runtime);
    const menuBody = jsonOf(menu.stdout);
    expect(menuBody).toMatchObject({ ok: true, command: "menu", storeCode: "DEMO-A", cached: false });
    expect(menuBody.meals).toEqual(expect.arrayContaining([expect.objectContaining({ code: "1440", name: "麦辣鸡腿汉堡" })]));
    const again = await executeAgent(["agent", "menu", "--store", "DEMO-A", "--json"], runtime);
    expect(jsonOf(again.stdout).cached).toBe(true);
    expect(calls(mcp, "query-meals")).toBe(1);

    const items = JSON.stringify([{ code: "1440", qty: 1 }]);
    const quote = await executeAgent(
      ["agent", "quote", "--store", "DEMO-A", "--store-name", "演示门店 A", "--items", items, "--json"],
      runtime,
    );
    const quoteBody = jsonOf(quote.stdout);
    expect(quoteBody).toMatchObject({
      ok: true,
      command: "quote",
      storeCode: "DEMO-A",
      storeName: "演示门店 A",
      totalFen: 2250,
      totalText: "¥22.5",
      orderPlaced: false,
    });
    expect(quoteBody.quoteId).toMatch(/^q_[0-9a-f]{16}$/);
    expect(quoteBody.lines).toEqual([
      expect.objectContaining({ code: "1440", name: "麦辣鸡腿汉堡", qty: 1, subtotalFen: 2250 }),
    ]);

    const status = await executeAgent(["agent", "status", "--json"], runtime);
    expect(jsonOf(status.stdout)).toMatchObject({
      ok: true,
      command: "status",
      orders: [expect.objectContaining({ orderId: "DEMO-ORDER-0001", orderStatus: "订单已完成" })],
    });

    const combined = `${stores.stdout}${menu.stdout}${quote.stdout}${status.stdout}${stores.stderr}`;
    expect(combined).not.toContain(TOKEN);
    expect(combined).not.toContain(SECRET);
    expect(combined).not.toContain("Bearer");
    expect(calls(mcp, "create-order")).toBe(0);
    expect(calls(mcp, "cancel-order")).toBe(0);
  });

  it("没有 order 和 cancel 子命令，也不会调用写接口", async () => {
    const mcp = mockMcp();
    for (const command of ["order", "cancel", "create-order", "cancel-order"]) {
      const result = await executeAgent(["agent", command, "--json"], {
        env: envOf(tempDir()),
        mcp,
        limiter: new MemoryRateLimiter(),
      });
      expect(result.code).toBe(1);
      expect(jsonOf(result.stdout)).toMatchObject({ ok: false, code: "UNKNOWN_COMMAND" });
      expect(result.stdout).not.toContain(TOKEN);
    }
    expect(mcp.calls).toHaveLength(0);
  });

  it("缺少 LARK_MCD_AGENT 时拒绝，并且不调用 MCP", async () => {
    const mcp = mockMcp();
    const env = envOf(tempDir());
    delete env.LARK_MCD_AGENT;
    const result = await executeAgent(["agent", "stores", "--near", "上海 人民广场", "--json"], { env, mcp });
    expect(result.code).toBe(1);
    expect(jsonOf(result.stdout).code).toBe("NOT_CONFIGURED");
    expect(result.stderr).toContain("cron");
    expect(mcp.calls).toHaveLength(0);
  });

  it("mock 模式不访问网络", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("不应该访问网络");
    };
    try {
      const result = await executeAgent(["agent", "stores", "--near", "上海 人民广场", "--json"], {
        env: envOf(tempDir()),
        now: () => NOW,
      });
      expect(jsonOf(result.stdout).ok).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("每分钟 6 次，第 7 次 RATE_LIMITED，并且跨实例生效", async () => {
    const dir = tempDir();
    const mcp = mockMcp();
    const env = envOf(dir);
    for (let index = 0; index < 6; index += 1) {
      const result = await executeAgent(["agent", "stores", "--near", "上海 人民广场", "--json"], { env, mcp, now: () => NOW });
      expect(jsonOf(result.stdout).ok).toBe(true);
    }
    const blocked = await executeAgent(["agent", "stores", "--near", "上海 人民广场", "--json"], { env, mcp, now: () => NOW });
    expect(jsonOf(blocked.stdout).code).toBe("RATE_LIMITED");
    expect(calls(mcp, "query-nearby-stores")).toBe(6);

    const fileLimiter = new FileRateLimiter(dir);
    expect(() => fileLimiter.take(NOW)).toThrow(AgentError);
  });

  it("每天 60 次之后拒绝", () => {
    const limiter = new MemoryRateLimiter();
    let now = NOW;
    for (let index = 0; index < 60; index += 1) {
      limiter.take(now);
      now += 61_000;
    }
    expect(() => limiter.take(now)).toThrow(/每天/);
  });

  it("同一订单的刷新冷却会落盘", async () => {
    const dir = tempDir();
    const env = envOf(dir);
    const firstMcp = mockMcp();
    const first = await executeAgent(["agent", "status", "--order", "NO-SUCH-ORDER", "--json"], { env, mcp: firstMcp, now: () => NOW });
    expect(jsonOf(first.stdout).code).toBe("MCP_ERROR");
    expect(calls(firstMcp, "query-order")).toBe(1);
    const secondMcp = mockMcp();
    const second = await executeAgent(["agent", "status", "--order", "NO-SUCH-ORDER", "--json"], {
      env,
      mcp: secondMcp,
      now: () => NOW + 1_000,
    });
    expect(jsonOf(second.stdout).code).toBe("COOLDOWN");
    expect(secondMcp.calls).toHaveLength(0);
  });

  it("propose 只建立待确认提议并推卡片，确认按钮再走现有下单路径", async () => {
    const proposals = new MemoryProposalStore();
    const notifier = new MemoryNotifier();
    const agentMcp = mockMcp();
    const limiter = new MemoryRateLimiter();
    const env = envOf(tempDir());
    const runtime = { env, mcp: agentMcp, proposals, limiter, notifier, now: () => NOW };
    const quoted = await executeAgent(
      ["agent", "quote", "--store", "DEMO-A", "--store-name", "演示门店 A", "--items", JSON.stringify([{ code: "1440", qty: 1 }]), "--json"],
      runtime,
    );
    const quoteId = jsonOf(quoted.stdout).quoteId;
    expect(typeof quoteId).toBe("string");
    const proposed = await executeAgent(["agent", "propose", "--quote", String(quoteId), "--json"], runtime);
    const body = jsonOf(proposed.stdout);
    expect(body).toMatchObject({
      ok: true,
      command: "propose",
      status: "pending",
      delivered: true,
      orderPlaced: false,
      quoteId,
    });
    const proposalId = String(body.proposalId);
    expect(proposals.getProposal(proposalId)?.status).toBe("pending");
    expect(agentMcp.calls.map((call) => call.tool)).toEqual(["calculate-price"]);
    expect(notifier.openIds).toEqual(["owner"]);
    expect(proposed.stdout).not.toContain(TOKEN);
    const cardJson = JSON.stringify(notifier.cards[0]);
    expect(cardJson).not.toContain(TOKEN);
    expect(cardJson).not.toContain("2250");
    expect(collectCardText(notifier.cards[0]!)).toContain("还没有下单");
    const confirm = buttonValue(notifier.cards[0]!, "确认下单");
    expect(confirm).toMatchObject({ a: "order.confirm", sid: proposalId, v: 1 });

    const dry = setup({ proposals, dryRun: true, now: () => NOW });
    const preview = await dry.flow.onCard(card({ action: "order.confirm", sessionId: proposalId, eventId: "agent-dry" }));
    expect(collectCardText(preview.card!)).toContain("没有向麦当劳下单");
    expect(calls(dry.mcp, "create-order")).toBe(0);
    expect(proposals.getProposal(proposalId)?.status).toBe("pending");

    const live = setup({ proposals, dryRun: false, now: () => NOW });
    const ordered = await live.flow.onCard(card({ action: "order.confirm", sessionId: proposalId, eventId: "agent-live" }));
    expect(ordered.card?.header.title.content).toContain("已下单");
    expect(calls(live.mcp, "create-order")).toBe(1);
    const create = live.mcp.calls.find((call) => call.tool === "create-order");
    expect(create?.args).toMatchObject({ orderType: 1, beType: 1, storeCode: "DEMO-A" });
    expect(create?.args).not.toHaveProperty("withOrder");
    expect(proposals.getProposal(proposalId)?.status).toBe("confirmed");

    const replay = setup({ proposals, dryRun: false, now: () => NOW });
    const again = await replay.flow.onCard(card({ action: "order.confirm", sessionId: proposalId, eventId: "agent-replay" }));
    expect(again.toast?.content).toContain("已经确认");
    expect(calls(replay.mcp, "create-order")).toBe(0);
  });

  it("报价过期时不建立提议", async () => {
    const proposals = new MemoryProposalStore();
    const env = envOf(tempDir());
    const runtime = {
      env,
      mcp: mockMcp(),
      proposals,
      limiter: new MemoryRateLimiter(),
      notifier: new MemoryNotifier(),
      now: () => NOW,
    };
    const quoted = await executeAgent(
      ["agent", "quote", "--store", "DEMO-A", "--items", JSON.stringify([{ code: "1440", qty: 1 }]), "--json"],
      runtime,
    );
    const quoteId = String(jsonOf(quoted.stdout).quoteId);
    const expired = await executeAgent(["agent", "propose", "--quote", quoteId, "--json"], {
      ...runtime,
      now: () => NOW + QUOTE_TTL_MS + 1,
    });
    expect(jsonOf(expired.stdout).code).toBe("QUOTE_EXPIRED");
    expect(proposals.listProposals()).toHaveLength(0);
  });

  it("放下提议不会下单", async () => {
    const proposals = new MemoryProposalStore();
    const notifier = new MemoryNotifier();
    const env = envOf(tempDir());
    const runtime = { env, mcp: mockMcp(), proposals, limiter: new MemoryRateLimiter(), notifier, now: () => NOW };
    const quoted = await executeAgent(
      ["agent", "quote", "--store", "DEMO-A", "--items", JSON.stringify([{ code: "1440", qty: 1 }]), "--json"],
      runtime,
    );
    const proposed = await executeAgent(["agent", "propose", "--quote", String(jsonOf(quoted.stdout).quoteId), "--json"], runtime);
    const proposalId = String(jsonOf(proposed.stdout).proposalId);
    const { flow, mcp } = setup({ proposals, dryRun: false, now: () => NOW });
    const result = await flow.onCard(card({ action: "order.dismiss", sessionId: proposalId, eventId: "agent-dismiss" }));
    expect(collectCardText(result.card!)).toContain("没有下单");
    expect(calls(mcp, "create-order")).toBe(0);
    expect(proposals.getProposal(proposalId)?.status).toBe("dismissed");
  });

  it("SKILL.md 只用通用 frontmatter", () => {
    const text = readFileSync("skills/lark-mcd/SKILL.md", "utf8");
    expect(text.startsWith("---\n")).toBe(true);
    const end = text.indexOf("\n---\n", 4);
    const front = text.slice(4, end);
    expect(front).toMatch(/^name:\s*lark-mcd\s*$/m);
    expect(front).toMatch(/^license:\s*MIT\s*$/m);
    expect(front).toMatch(/^description:\s*\S+/m);
    expect(front).toMatch(/^compatibility:\s*\S+/m);
    const description = /^description:\s*(.+)$/m.exec(front)?.[1] ?? "";
    expect(description.length).toBeGreaterThan(20);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(front).not.toContain("disable-model-invocation");
    expect(front).not.toContain("allowed-tools");
    for (const line of front.split("\n")) {
      if (!line.trim() || line.startsWith(" ") || line.startsWith("\t")) continue;
      const key = line.slice(0, line.indexOf(":"));
      expect(["name", "description", "license", "compatibility", "metadata"]).toContain(key);
    }
    expect(text).toContain("lark-mcd agent");
    expect(text).toContain("--json");
  });

  it("打包脚本产出可上传的技能 zip", () => {
    const result = spawnSync(process.execPath, ["scripts/pack-skill.mjs"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    const names = zipEntryNames(readFileSync("dist/lark-mcd-skill.zip"));
    expect(names).toEqual(["SKILL.md", "manifest.yaml", "references/commands.md"]);
  });

  it("bin 能打印帮助", () => {
    const result = spawnSync(process.execPath, ["bin/lark-mcd.mjs", "agent", "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("propose");
    expect(result.stdout).toContain("LARK_MCD_AGENT");
  }, 20_000);
});

function zipEntryNames(zip: Buffer): string[] {
  const names: string[] = [];
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const compressed = zip.readUInt32LE(offset + 18);
    names.push(zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8"));
    offset += 30 + nameLength + extraLength + compressed;
  }
  return names.sort();
}

function buttonValue(cardToRead: FeishuCard, label: string): Record<string, unknown> | undefined {
  for (const element of cardToRead.body.elements) {
    const text = (element.text as { content?: string } | undefined)?.content;
    if (text !== label) continue;
    const behaviors = element.behaviors as { value?: Record<string, unknown> }[] | undefined;
    return behaviors?.[0]?.value;
  }
  return undefined;
}
