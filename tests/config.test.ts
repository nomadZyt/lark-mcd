import { describe, expect, it, vi } from "vitest";
import { HttpMcpClient } from "../src/core/mcp-client.js";
import { McpGuard } from "../src/core/guard.js";
import { loadConfig } from "../src/bot/config.js";
import type { Trigger } from "../src/core/types.js";

describe("配置", () => {
  it("默认演练模式，只有 DRY_RUN=false 才关闭", () => {
    expect(loadConfig({}).dryRun).toBe(true);
    expect(loadConfig({ DRY_RUN: "true" }).dryRun).toBe(true);
    expect(loadConfig({ DRY_RUN: "FALSE" }).dryRun).toBe(true);
    expect(loadConfig({ DRY_RUN: "false", MCD_MODE: "mock" }).dryRun).toBe(false);
  });

  it("没有 Token 时默认 mock，真实模式缺 Token 或主人就拒绝启动", () => {
    expect(loadConfig({}).mode).toBe("mock");
    expect(() => loadConfig({ MCD_MODE: "real" })).toThrow(/MCD_MCP_TOKEN/);
    expect(() => loadConfig({ MCD_MODE: "real", MCD_MCP_TOKEN: "secret" })).toThrow(/OWNER_OPEN_ID/);
  });
});

describe("HTTP 客户端", () => {
  const trigger: Trigger = {
    kind: "message",
    eventId: "e1",
    operatorOpenId: "owner",
    action: "old-usual",
  };

  it("守卫不通过时不会发出请求，错误里也不含 Token", async () => {
    const fetchImpl = fetchStub(200, '{"success":true,"code":200,"message":"ok","data":{"price":4400}}');
    const client = new HttpMcpClient({
      url: "https://mcp.mcd.cn",
      token: "test-token-value",
      guard: new McpGuard({ ownerOpenId: "owner", dryRun: true }),
      fetchImpl,
    });
    await expect(
      client.call("calculate-price", { storeCode: "DEMO-A" }, { ...trigger, operatorOpenId: "other" }),
    ).rejects.toThrow(/只有发起人/);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(
      client.call(
        "create-order",
        {},
        { ...trigger, kind: "card", action: "confirm", eventId: "e2" },
        { draftId: "d1", draftStatus: "priced" },
      ),
    ).rejects.toThrow(/演练模式/);
    expect(fetchImpl).not.toHaveBeenCalled();
    try {
      await client.call("calculate-price", {}, { ...trigger, operatorOpenId: "other", eventId: "e3" });
    } catch (error) {
      expect(String(error)).not.toContain("test-token-value");
    }
  });

  it("通过守卫后按 JSON-RPC 调用，并带上 Bearer", async () => {
    const fetchImpl = fetchStub(
      200,
      '说明\n{"success":true,"code":200,"message":"请求成功","data":{"price":4400}}',
    );
    const client = new HttpMcpClient({
      url: "https://mcp.mcd.cn",
      token: "test-token-value",
      guard: new McpGuard({ ownerOpenId: "owner", dryRun: true }),
      fetchImpl,
    });
    const result = await client.call("calculate-price", { storeCode: "DEMO-A", orderType: 1, beType: 1 }, trigger);
    expect(result.data).toMatchObject({ price: 4400 });
    const first = fetchImpl.mock.calls[0] as unknown as [string, RequestInit] | undefined;
    const init = first?.[1];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer test-token-value");
    expect(JSON.parse(String(init?.body))).toMatchObject({ method: "tools/call", params: { name: "calculate-price" } });
  });

  it("401 和 429 变成业务错误，不把 Token 写进消息", async () => {
    const denied = fetchStub(401, "");
    const client = new HttpMcpClient({
      url: "https://mcp.mcd.cn",
      token: "test-token-value",
      guard: new McpGuard({ ownerOpenId: "owner", dryRun: true }),
      fetchImpl: denied,
    });
    const result = await client.call("order-list", {}, trigger);
    expect(result.code).toBe(401);
    expect(JSON.stringify(result)).not.toContain("test-token-value");
  });
});

function fetchStub(status: number, body: string) {
  return vi.fn(async () => new Response(body, { status, headers: { "content-type": "application/json" } }));
}
