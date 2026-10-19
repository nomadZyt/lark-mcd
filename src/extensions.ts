/**
 * 这一版没有实现的能力。接口留在这里，避免下一版把 MCP 调用散落到定时任务或群成员点击里。
 * 定时提醒如果要做，只能发本地卡片，不能 import MCP 客户端。
 */
export const NEXT_STEPS = [
  {
    id: "group-vote",
    title: "群投票拼单",
    note: "成员只在卡片上勾选，调用 MCP 0 次。只有 Token 主人可以核价和下单，付款链接只私发给发起人。",
  },
  {
    id: "aa-bitable",
    title: "AA 与报销多维表格",
    note: "分摊用分做整数，余数由发起人承担。表格不写手机号、地址、取餐码和完整订单号。",
  },
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

export interface GroupVotePort {
  /** 本版不实现。 */
  start(input: unknown): Promise<never>;
}

export interface LedgerPort {
  /** 本版不实现。 */
  write(input: unknown): Promise<never>;
}

export interface ReminderPort {
  /** 本版不实现。实现时禁止调用 MCP。 */
  schedule(input: unknown): Promise<never>;
}
