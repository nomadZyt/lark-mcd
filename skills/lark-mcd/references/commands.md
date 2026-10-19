# lark-mcd agent 命令

标准输出是一行 JSON。标准错误是给人看的短句。JSON 里不会出现 MCP Token 或飞书 App Secret。

所有命令都要带 `--json`。本机要有 `LARK_MCD_AGENT=1`。没有 `order` 和 `cancel`。

`mode` 为 `mock` 时，`notice` 会说明这是演示数据，价格不是实时价。`orderPlaced` 在 Agent 命令里始终是 `false`。真正下单只发生在飞书卡片的「确认下单」按钮上。

## stores

```bash
node "$LARK_MCD_HOME/bin/lark-mcd.mjs" agent stores --near "上海 人民广场" --json
```

`--near` 必须是「城市」加空格加「关键词」。对应 MCP 工具 `query-nearby-stores`（`beType=1`，`searchType=2`）。

```json
{
  "ok": true,
  "command": "stores",
  "mode": "mock",
  "orderPlaced": false,
  "notice": "当前是演示数据，价格和门店不代表实时结果。",
  "stores": [
    { "storeCode": "DEMO-A", "storeName": "演示门店 A", "businessStatus": true }
  ]
}
```

## menu

```bash
node "$LARK_MCD_HOME/bin/lark-mcd.mjs" agent menu --store DEMO-A --json
```

对应 `query-meals`。同一门店的结果在本机缓存 5 分钟，缓存命中时 `cached` 为 `true`，不再请求 MCP。

```json
{
  "ok": true,
  "command": "menu",
  "mode": "mock",
  "orderPlaced": false,
  "storeCode": "DEMO-A",
  "cached": false,
  "meals": [
    { "code": "1440", "name": "麦辣鸡腿汉堡", "currentPrice": "22.5", "originalPrice": "22.5" }
  ]
}
```

## quote

```bash
node "$LARK_MCD_HOME/bin/lark-mcd.mjs" agent quote --store DEMO-A --store-name "演示门店 A" --items '[{"code":"1440","qty":1}]' --json
```

`--items` 是 JSON 数组。商品用 `code` + `qty`，也接受 `productCode` + `quantity`。一次最多 20 行，每行数量 1 到 20。`--store-name` 可选，只用于卡片标题。

对应 `calculate-price`。报价写入本机，5 分钟后失效。金额以 `totalFen`（分，整数）为准，`totalText` 只用于展示。

```json
{
  "ok": true,
  "command": "quote",
  "mode": "mock",
  "orderPlaced": false,
  "quoteId": "q_0123456789abcdef",
  "expiresAt": "2026-10-19T04:05:00.000Z",
  "ttlMs": 300000,
  "storeCode": "DEMO-A",
  "storeName": "演示门店 A",
  "takeWay": "堂食",
  "totalFen": 2250,
  "totalText": "¥22.5",
  "discountFen": 0,
  "lines": [
    { "code": "1440", "name": "麦辣鸡腿汉堡", "qty": 1, "subtotalFen": 2250, "subtotalText": "¥22.5" }
  ]
}
```

## propose

```bash
node "$LARK_MCD_HOME/bin/lark-mcd.mjs" agent propose --quote q_0123456789abcdef --json
```

不调用麦当劳 MCP。把报价发成飞书私聊卡片给 `OWNER_OPEN_ID`。卡片上的「确认下单」走机器人现有的确认流程：`DRY_RUN` 不是 `false` 时不会调用下单接口。

需要 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`，以及已经启动的飞书机器人。报价过期时返回 `QUOTE_EXPIRED`，不会发卡片。

```json
{
  "ok": true,
  "command": "propose",
  "mode": "mock",
  "orderPlaced": false,
  "proposalId": "p_0123456789abcdef",
  "quoteId": "q_0123456789abcdef",
  "status": "pending",
  "delivered": true,
  "message": "已推送到飞书，请 Token 主人在卡片上点确认。这一步没有调用下单接口。"
}
```

## status

```bash
node "$LARK_MCD_HOME/bin/lark-mcd.mjs" agent status --json
node "$LARK_MCD_HOME/bin/lark-mcd.mjs" agent status --order DEMO-ORDER-0001 --json
```

不带 `--order` 时调用 `order-list`。带 `--order` 时调用 `query-order`。同一订单 10 秒内再次查询返回 `COOLDOWN`。

```json
{
  "ok": true,
  "command": "status",
  "mode": "mock",
  "orderPlaced": false,
  "orders": [
    {
      "orderId": "DEMO-ORDER-0001",
      "orderStatus": "订单已完成",
      "storeName": "演示门店 A",
      "total": "84.8",
      "items": [{ "code": "1440", "name": "麦辣鸡腿汉堡", "quantity": 2 }]
    }
  ]
}
```

## 失败

```json
{ "ok": false, "command": "stores", "code": "RATE_LIMITED", "message": "Agent 入口每分钟最多 6 次。不要放进定时任务、心跳或后台任务。" }
```

| code | 含义 |
| --- | --- |
| `NOT_CONFIGURED` | 缺少 `LARK_MCD_AGENT=1`、Token、飞书凭证或主人 open_id |
| `BAD_ARGS` | 参数不完整，或忘了 `--json` |
| `UNKNOWN_COMMAND` | 命令不存在。下单和取消一定走这里 |
| `RATE_LIMITED` | 每分钟 6 次或每天 60 次（北京时间） |
| `COOLDOWN` | 同一订单 10 秒内重复查询 |
| `QUOTE_NOT_FOUND` | 没有这份报价 |
| `QUOTE_EXPIRED` | 报价超过 5 分钟 |
| `TOOL_DISABLED` | 守卫拒绝了这次调用 |
| `MCP_ERROR` | 麦当劳接口返回了业务错误 |
| `DELIVER_FAILED` | 飞书卡片没有发出。提议会标成已放下，避免一张没人看到的卡片以后被点掉 |
