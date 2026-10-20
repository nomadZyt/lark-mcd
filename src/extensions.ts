/**
 * 还没做的能力。接口留在这里，避免下一版把 MCP 调用散落到定时任务里。
 * 定时提醒如果要做，只能发本地卡片，不能 import MCP 客户端。
 * 群投票和 AA 台账已经实现，见 src/bot/group-flow.ts 和 src/bot/ledger.ts。
 */
export const NEXT_STEPS = [
  {
    id: "reminder",
    title: "前一晚提醒",
    note: "到点只发一张提醒卡，调用 MCP 0 次。用户点击之后才核价。",
  },
  {
    id: "web-simulator",
    title: "GitHub Pages 卡片模拟器",
    note: "纯静态页面，复用同一套卡片 JSON，不连接麦当劳，也不放 Token。",
  },
] as const;

export interface ReminderPort {
  /** 本版不实现。实现时禁止调用 MCP。 */
  schedule(input: unknown): Promise<never>;
}
