# 麦麦卡片 lark-mcd

在飞书里点麦当劳。私聊说一句「老样子」，机器人回一张核好价的卡片；你自己点付款链接。群里可以一起勾选，由发起人一个人下单，AA 记进多维表格。卡片上的会员卡小算盘只建议这张卡大概多久回本，不会替你买。

麦当劳程序员创意开发大赛参赛作品。程序跑在你自己的电脑上，Token 不出本机。

[![ci](https://github.com/nomadZyt/lark-mcd/actions/workflows/ci.yml/badge.svg)](https://github.com/nomadZyt/lark-mcd/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

![私聊「老样子」演示（占位）](docs/demo-private.svg)

> 演示 GIF 还是占位图。下一版用 mock 模式录屏后替换 `docs/demo-private.svg`。现在可以直接跑 `npm run demo`。

## 这一版能做什么

- 私聊「老样子」：用本机保存的配方调用 `calculate-price`，回一张到店自取的核价卡片。
- 点「确认下单」：默认演练模式，只展示将要提交的内容。把 `DRY_RUN=false` 写进本机 `.env` 之后，才会调用 `create-order`，并给出麦当劳返回的付款链接。
- 点「我付好了，刷新」：调用一次 `query-order`，显示订单状态和取餐码。同一订单 10 秒内只能刷新一次。
- 会员卡小算盘：再核一次带随单购参数的价格，算出餐品大约能省多少、按你填的频率大概几次回本。它不下单，也不购买会员卡。
- Agent 入口：WorkBuddy、OpenClaw、Hermes 或 Claude Code 可以查门店、菜单、核价和订单，并把报价推到飞书。它们不能下单。
- 群投票：在群里 @机器人，发送 `/麦麦 拼单 午饭 12:00`。大家在卡片上改自己的份数，这一步不调用麦当劳接口。一场只对应发起人已经保存的那一家店、这一个时段，最多 10 份。
- 发起人点「截止并核价」，再点「确认下单」。下单仍走原来的演练和守卫。付款链接只私发给发起人，群卡片里没有这个链接。发起人自己付款，机器人不收款。
- AA 台账：按整数「分」分摊，除不尽的分由发起人承担。配置了多维表格就写入飞书；没配置就写本机 `~/.lark-mcd/ledger.json`。表里不写手机号、地址、取餐码和完整订单号。

前一晚提醒和网页模拟器还没做，接口留在 `src/extensions.ts`。

## 30 秒本地体验

不需要麦当劳 Token，也不需要飞书。

```bash
git clone https://github.com/nomadZyt/lark-mcd.git
cd lark-mcd
npm install
npm test
npm run demo
```

`npm run demo` 会在终端打印核价卡片、小算盘结果、演练模式下「确认下单」的预览，以及群投票、AA 分摊和本机台账。演练模式调用 `create-order` 的次数是 0。成员勾选也不会调用麦当劳接口。

## 接到你自己的飞书（个人测试租户）

用个人测试租户里的企业自建应用，长连接跑在本机。不要用公司租户，也不要把应用部署到公网。

1. 打开 [飞书开放平台](https://open.feishu.cn) ，登录你的个人测试租户。
2. 创建企业自建应用。名称可以用「麦麦卡片」。
3. 在应用能力里启用机器人。
4. 只开通下面这些权限。不要开通「获取群组中所有消息」（`im:message.group_msg`），也不要开通通讯录全量。
   - `im:message.p2p_msg:readonly`：获取用户发给机器人的单聊消息
   - `im:message.group_at_msg:readonly`：接收群聊中 @ 机器人的消息
   - `im:message:send_as_bot`：以应用的身份发消息
   - `im:message`：获取与发送单聊、群组消息，用来更新机器人自己发出的卡片
   - `base:record:create`：新增多维表格记录（AA 台账）
   - `base:record:update`：更新多维表格记录里的支付状态
   - 如果后台把表格权限收成旧版的 `bitable:app`（查看、评论、编辑和管理多维表格），开通这一项即可，不必再加删除记录的权限
5. 进入「事件与回调」。事件订阅和回调配置都选择「使用长连接接收」。
   - 事件：`im.message.receive_v1`
   - 回调：`card.action.trigger`（新版卡片回传交互）
   - 不要订阅旧版「消息卡片回传交互」。旧版不支持长连接。
6. 先在本机启动程序，等日志出现「麦麦卡片已启动」，再回到开放平台保存长连接。后台要求本地程序已经连上，才能保存订阅方式。
7. 打开「版本管理与发布」，创建版本。可用范围选你自己。把这个版本发布到当前测试租户。
8. 在「凭证与基础信息」复制 App ID 和 App Secret，写入本机 `.env` 的 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`。
9. 先把 `OWNER_OPEN_ID` 留空或随便填一个，`MCD_MODE=mock`，然后 `npm start`。给机器人发一句话。它会回复你的 open_id，并且不会调用麦当劳接口。把这个 open_id 写进 `OWNER_OPEN_ID`，重启。只有这个账号的消息和点击会触发 MCP。

同一应用不要同时开两个长连接进程，否则回调会随机落到其中一个上。

```bash
cp .env.example .env
# 编辑 .env 后：
npm start
```

## 群拼单和 AA 台账

详细步骤在 [docs/group-order.md](docs/group-order.md)。个人测试租户里可以这样试：

1. 先在私聊设好门店：`/麦麦 门店 城市 关键词`，点一家保存。群拼单用的就是这一家店。
2. 建一个测试群，把机器人拉进去。在群里 @机器人，发送 `/麦麦 拼单 午饭 12:00`。事由可以写成午饭、加班餐、团队活动或其他，时间用 `HH:mm`。
3. 其他成员点卡片上的加号、减号。这些点击不会调用麦当劳接口。总共最多 10 份。
4. 用 `OWNER_OPEN_ID` 对应的账号点「截止并核价」，再点「确认下单（发起人）」。别人点这两个按钮，只会看到「只有发起人可以核价和下单」。
5. 保持 `DRY_RUN=true` 时不会真正下单。群里的卡片写明没有下单。发起人的私聊里是将要提交的内容，没有付款链接。
6. 只有把 `DRY_RUN=false` 写进本机 `.env` 并重启之后，确认才会调用 `create-order`。付款链接只出现在发起人的私聊里。群卡片写「已下单，待发起人付款」。

多维表格要自己在个人测试租户里建。应用需要这两个权限：`base:record:create`、`base:record:update`，并且要被加为这张表的协作者（可编辑）。表字段见 [docs/group-order.md](docs/group-order.md)。把表格链接里的 `app_token` 和数据表 `table_id` 写进 `.env`：

```bash
BITABLE_APP_TOKEN=
BITABLE_TABLE_ID=
```

两个都留空时，台账写到本机 `~/.lark-mcd/ledger.json`，不请求飞书表格。写入失败时也会退回这个文件。

给机器人私聊「老样子」。还没设门店时，它会提示：

```text
/麦麦 门店 城市 关键词
```

点选一家门店后，配方保存在本机 `~/.lark-mcd/state.json`。

## 接到麦当劳 MCP

Token 在 [麦当劳 MCP 开放平台](https://open.mcd.cn/mcp) 用你自己的手机号申请。它和你的会员账号绑在一起，只放本机 `.env`。

```bash
MCD_MODE=real
MCD_MCP_TOKEN=你的token
DRY_RUN=true
```

先保持 `DRY_RUN=true` 走一遍。卡片会核价，但点「确认下单」不会调用 `create-order`。确认没问题后，才把 `DRY_RUN` 改成 `false`。付款链接打开的是麦当劳的页面，这个程序不付款、不代收。

`mcp-config.example.json` 只给 Cursor 一类 MCP 客户端做参考，里面是 `${MCD_MCP_TOKEN}` 占位符。机器人自己读环境变量，不读这个文件。Agent 入口不要使用这份直连配置。

## Agent 入口 / WorkBuddy

飞书卡片机器人仍然是唯一可以下单和取消订单的地方。Agent 入口只能查门店、菜单、核价、订单状态，以及 `propose`：把报价推到你的飞书私聊。你在卡片上点「确认下单」之后，才走原来的演练或下单流程。

安装、以及 WorkBuddy / OpenClaw / Hermes / Claude Code 的配置，见 [docs/agents.md](docs/agents.md)。技能文件在 `skills/lark-mcd/SKILL.md`。

```bash
# 本机 .env 或环境变量。不要写进 cron、heartbeat 或定时任务。
LARK_MCD_AGENT=1
node bin/lark-mcd.mjs agent stores --near "上海 人民广场" --json
```

不要把 `MCD_MCP_TOKEN` 填进 WorkBuddy、OpenClaw 或 Hermes 的 MCP 连接器，也不要让它们直连 `https://mcp.mcd.cn`。那样会绕过守卫，模型还能看到领券和抽奖一类工具。Token 只放在本机环境变量或 `.env`。

`workbuddy.md` 需要你本人在腾讯 WorkBuddy 里导出真实对话后再填。云端编码会话不算 WorkBuddy 使用。

## 安全与合规

- 不自动下单。没有你当场发消息或点按钮，就不会调用麦当劳接口。Agent 入口也不能下单。
- 不要把 Agent 命令放进定时任务、心跳或后台任务。`LARK_MCD_AGENT=1` 只在你当面使用时打开。
- 不自动付款。订单只给你付款链接，钱不经过这个程序。
- 不轮询。没有定时器去查订单或刷菜单。刷新订单必须再点一次，而且 10 秒内只能点一次。
- 不领券，不抽奖，不兑换积分，不创建外送地址。这些工具没有实现。
- Token 留在本机 `.env`。`.gitignore` 忽略 `.env`。日志会抹掉 Authorization 和 App Secret。
- 群成员只能改自己的份数。核价、下单、刷新取餐码只有 Token 主人可以点。付款链接只进发起人的私聊。
- 会员卡小算盘只计算，不购买。
- 餐品、价格和订单状态以麦当劳 App 显示为准。

服务规则见 [麦当劳 MCP 服务规则](https://cdn.mcd.cn/cms/pages/MCPServerRules.html)。更细的调用说明在 [MCP_INTEGRATION.md](MCP_INTEGRATION.md)。

## 真实性

| 能力 | 状态 |
| --- | --- |
| `query-nearby-stores`、`query-meals`、`calculate-price`、`order-list` | 演示数据来自 2026-10-19 的只读调用，已脱敏并裁剪，价格不是实时价 |
| `create-order`、`query-order`、`cancel-order` | 按官方文档结构做了 mock，这个仓库没有用真实 Token 下过单 |
| 飞书长连接和 `card.action.trigger` | 按官方 Node SDK 写的，需要你在自己的测试租户里点一次 |
| 群投票和 AA 分摊 | 本地状态和整数分计算，单测覆盖。多维表格按飞书 OpenAPI 写入，需要你在个人测试租户里建表后试一次 |

## 常见问题

电脑合上或休眠时，机器人就离线了。这是故意的：为了一直在线把 Token 放到服务器上，不符合「凭证不托管到第三方」的规则。

套餐只传商品编码和数量，卡片上会写「套餐按默认搭配」。

这一版只做到店自取。麦乐送、团餐、得来速没做。

群拼单上的时段是大家约定的取餐时间。核价和下单按到店即时单处理，不会把这个时间当成预约时间传给麦当劳。

为什么群成员不能自己下单：麦当劳 MCP 的 Token 属于发起人本人。别人的点击如果也能下单，就变成替别人使用这份凭证。所以只有 `OWNER_OPEN_ID` 可以核价和确认。机器人不向群成员收款，AA 只是记账，结算在线下完成。

## 免责声明

本项目是麦当劳程序员节创意开发大赛的参赛作品，由参赛者独立开发，不是麦当劳官方产品。输出仅供参考。餐品信息、价格和供应状态以麦当劳官方渠道的实时结果为准。参赛声明见 [CONTEST_DECLARATION.md](CONTEST_DECLARATION.md)。

如果它帮你少翻几次 App，欢迎点个 Star。

## English

Order McDonald's inside Feishu. Say "the usual" in a direct message, get a priced card, and pay on McDonald's own page. A membership-card calculator only suggests whether a card pays off. It never buys one.

```bash
npm install
npm test
npm run demo
```

The bot runs on your own computer over a Feishu WebSocket long connection. It does not auto-order, auto-pay, poll, or claim coupons. The MCP token stays in a local `.env` file. `DRY_RUN=true` unless you set `DRY_RUN=false`. An agent entry can look up stores, menus, quotes, and order status, then push a Feishu confirm card. It cannot place or cancel an order. See [docs/agents.md](docs/agents.md). In a group, members only adjust their own quantities. The token owner prices and places the order. The payment link is sent by direct message to that owner. Split amounts can be written to a Feishu base or a local JSON file. The evening reminder and the web simulator are not in this version.
