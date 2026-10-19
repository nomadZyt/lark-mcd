# 麦当劳 MCP 接入说明

## 服务

- 地址：`https://mcp.mcd.cn`
- 传输：Streamable HTTP。服务不返回 `Mcp-Session-Id`，每次请求独立。
- 鉴权：`Authorization: Bearer ${MCD_MCP_TOKEN}`
- 调用：`POST` JSON-RPC `tools/call`。结果在 `result.content[0].text` 里，是一段 Markdown 提示加原始 JSON。解析时定位到 `{"success"`。
- 配置示例：根目录 `mcp-config.example.json`，只有环境变量占位符。机器人进程不读这个文件，只读本机环境变量。

这一版只做到店自取：`orderType=1`、`beType=1`，不传 `beCode`。

## 用到的工具

| 用户动作 | 工具 | 次数上限 |
| --- | --- | --- |
| `/麦麦 门店 城市 关键词` | `query-nearby-stores`（`beType=1`，`searchType=2`） | 1 |
| 点「选这家」 | 不调用，只写入本机状态 | 0 |
| 私聊「老样子」，本机已有配方 | `calculate-price` | 1（预算 2） |
| 私聊「老样子」，本机没有配方 | `order-list`，有已完成订单再 `calculate-price`；没有则改为 `query-meals`，等下一次点击再核价 | 2 |
| 点「换一换」 | 菜单不在内存里时 `query-meals`，然后 `calculate-price` | 2 |
| 点「算一算」 | `calculate-price`（带 `withOrder`）；需要频率而又没填时再 `order-list`。菜单不在内存里时先 `query-meals` | 2 |
| 点「确认下单」 | `create-order`。演练模式不调用 | 1 |
| 点「我付好了，刷新」 | `query-order`。同一订单 10 秒内一次 | 1 |
| 点「确认取消」 | `cancel-order`。演练模式不调用 | 1 |

没有实现、也不会调用：`auto-bind-coupons`、`draw-lottery`、`mall-create-order`、`party-order-create`、`delivery-create-address`。

`create-order` 不带 `withOrder`。小算盘只比较价格，不购买会员卡。`query-meals` 里的 `withOrder.specId` 会映射成核价参数 `membershipSpecId`。这个映射还没拿真实下单核对过。

## 私聊时序

```mermaid
sequenceDiagram
    actor U as Token 主人
    participant F as 飞书
    participant B as 本机机器人
    participant M as 麦当劳 MCP
    U->>F: 私聊「老样子」
    F->>B: im.message.receive_v1
    B->>M: calculate-price
    B->>F: 核价卡片（含小算盘入口）
    U->>F: 点「确认下单」
    F->>B: card.action.trigger
    B-->>F: 3 秒内 toast「下单中…」
    alt DRY_RUN=true
        B->>F: 更新卡片，展示将要提交的内容
    else DRY_RUN=false
        B->>M: create-order
        B->>F: 更新卡片，去付款按钮打开 payH5Url
    end
    U->>F: 在麦当劳页面自己付款
    U->>F: 点「我付好了，刷新」
    B->>M: query-order
    B->>F: 取餐码和订单状态
```

付款按钮是 `open_url`，不走回调。卡片回传值只有动作名、会话 ID 和版本号，不放 Token，也不放完整价格。

## 守卫

`McpClient.call()` 必须带上 `trigger`：`kind`（消息或卡片）、`eventId`、`operatorOpenId`、`action`。

下面任一情况都会在发请求前抛错：

- 没有 trigger
- `operatorOpenId` 不是 `OWNER_OPEN_ID`
- 工具不在白名单里
- 同一次点击超过上表的次数
- 写操作不是卡片点击，或草稿还没核价
- `DRY_RUN` 不是字符串 `false`
- 同一草稿已经创建过订单
- 同一订单 10 秒内再次 `query-order`

默认 `DRY_RUN=true`。只有环境变量精确等于 `false` 才关闭。

菜单缓存在进程内存里，不落盘，也不随仓库公开整份菜单。`fixtures/` 里每个菜单不超过 10 个商品，门店名和编号都是演示值。

## 业务价值

上班时不用打开 App 翻最近一单。飞书里说「老样子」，先看到实时核价，再自己决定付不付款。会员卡小算盘把「这单加购后餐品能省多少、按每周几次大约多久回本」算出来，买不买仍由你在麦当劳 App 里决定。

价格和订单状态以麦当劳 App 显示为准。
