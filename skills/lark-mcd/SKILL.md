---
name: lark-mcd
description: 在本机查询麦当劳（McDonald's）门店、菜单并核价，再把报价推到飞书，由本人点按钮确认下单。用户明确说要点餐、查附近门店、看菜单、算价格或查订单状态时使用。本技能不能直接下单或取消订单。
license: MIT
compatibility: Requires Node.js >= 20, a local lark-mcd checkout (LARK_MCD_HOME), MCD_MCP_TOKEN in the local environment, and the lark-mcd Feishu bot so the owner can confirm. Do not use in cron or heartbeat.
metadata:
  author: lark-mcd
  version: "0.1.0"
---

# 规则（必须遵守）

- 只在用户本人当前这轮对话里明确要求时使用。不要放进定时任务、心跳、后台任务或自动化流程。
- 不要向用户索要 MCP Token，也不要在对话里输出、复述 Token。Token 只放在本机环境变量 `MCD_MCP_TOKEN` 或 lark-mcd 仓库的 `.env` 里。
- 不要把 Token 写进 WorkBuddy、OpenClaw、Hermes 或其他宿主的 MCP 连接器，也不要直连 `https://mcp.mcd.cn`。那样会绕过守卫。
- 你不能下单，也不能取消订单。核价后运行 `propose`，然后告诉用户去飞书卡片上点确认。
- 每次运行前先说明要查什么。命令一律加 `--json`，按 JSON 里的价格回答，不要编造价格。
- 命令返回 `TOOL_DISABLED`、`RATE_LIMITED`、`NOT_CONFIGURED`、`COOLDOWN`、`QUOTE_EXPIRED` 时，把 `message` 转告用户，不要重试绕过。

# 命令

在 `$LARK_MCD_HOME` 指向的仓库里运行。命令形式是 `lark-mcd agent <子命令> --json`。若 `lark-mcd` 还不在 PATH 上，用 `node "$LARK_MCD_HOME/bin/lark-mcd.mjs"` 代替 `lark-mcd`。

运行前，本机环境需要 `LARK_MCD_AGENT=1`。飞书卡片机器人（`npm start`）要开着，`propose` 才能把确认发到 Token 主人的私聊。

- `node "$LARK_MCD_HOME/bin/lark-mcd.mjs" agent stores --near "<城市 关键词>" --json`
- `node "$LARK_MCD_HOME/bin/lark-mcd.mjs" agent menu --store <storeCode> --json`
- `node "$LARK_MCD_HOME/bin/lark-mcd.mjs" agent quote --store <storeCode> --items '[{"code":"...","qty":1}]' --json`
- `node "$LARK_MCD_HOME/bin/lark-mcd.mjs" agent propose --quote <quoteId> --json`
- `node "$LARK_MCD_HOME/bin/lark-mcd.mjs" agent status --json`
- `node "$LARK_MCD_HOME/bin/lark-mcd.mjs" agent status --order <orderId> --json`

参数和 JSON 示例见 [references/commands.md](references/commands.md)。
