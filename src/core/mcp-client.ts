import { McpGuard } from "./guard.js";
import { parseMcpPayload } from "./parse.js";
import type { BusinessEnvelope, GuardMeta, Trigger } from "./types.js";

export interface McpClient {
  call(
    tool: string,
    args: Record<string, unknown>,
    trigger: Trigger,
    meta?: GuardMeta,
  ): Promise<BusinessEnvelope>;
}

export async function invokeGuarded(
  guard: McpGuard,
  tool: string,
  trigger: Trigger,
  meta: GuardMeta | undefined,
  send: () => Promise<BusinessEnvelope>,
): Promise<BusinessEnvelope> {
  const ticket = guard.begin(tool, trigger, meta);
  try {
    const result = await send();
    guard.finish(ticket, true);
    return result;
  } catch (error) {
    guard.finish(ticket, false);
    throw error;
  }
}

export class HttpMcpClient implements McpClient {
  private rpcId = 0;

  constructor(
    private readonly options: {
      url: string;
      token: string;
      guard: McpGuard;
      fetchImpl?: typeof fetch;
    },
  ) {
    if (!options.token) {
      throw new Error("缺少 MCD_MCP_TOKEN");
    }
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    trigger: Trigger,
    meta?: GuardMeta,
  ): Promise<BusinessEnvelope> {
    return invokeGuarded(this.options.guard, tool, trigger, meta, () => this.send(tool, args));
  }

  private async send(tool: string, args: Record<string, unknown>): Promise<BusinessEnvelope> {
    this.rpcId += 1;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(this.options.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: this.rpcId,
          method: "tools/call",
          params: { name: tool, arguments: args },
        }),
      });
    } catch {
      throw new Error("连接麦当劳 MCP 失败");
    }

    if (response.status === 401) {
      return { success: false, code: 401, message: "MCP Token 无效或过期" };
    }
    if (response.status === 429) {
      return { success: false, code: 429, message: "触发限流" };
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`麦当劳 MCP 返回 HTTP ${response.status}`);
    }
    return parseMcpPayload(text);
  }
}
