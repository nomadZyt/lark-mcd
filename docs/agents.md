# Agent 入口

飞书卡片机器人是唯一可以下单和取消订单的地方。群拼单也一样：成员只在群卡片上改份数，发起人点「确认下单」之后才进入原来的演练或下单流程。这一页讲的 Agent 入口给 WorkBuddy、OpenClaw、Hermes 和 Claude Code 用：它只能查询，以及把一份报价推到你的飞书私聊。你本人点卡片上的「确认下单」之后，才进入原来的演练或下单流程。Agent 不能发起群拼单，也不能替群成员下单。

`DRY_RUN` 默认仍是 `true`。没有在本机 `.env` 里写成 `false` 之前，点确认也不会调用下单接口。

## 不要这样做

不要把 `MCD_MCP_TOKEN` 粘进 WorkBuddy、OpenClaw、Hermes 或任何宿主的 MCP 连接器，也不要让它们直连 `https://mcp.mcd.cn`。

那样做会绕过本仓库的守卫。模型会看到麦当劳 MCP 上的全部工具，包括领券和抽奖。Token 也会进宿主的配置文件。

Token 只放在本机环境变量，或 lark-mcd 仓库里的 `.env`。不要贴进对话。JSON 输出里不会带 Token。

不要把 `lark-mcd agent` 放进 cron、heartbeat、定时任务、后台任务或无人值守会话。服务规则不支持自动化调用。`LARK_MCD_AGENT=1` 只在你当面让助手查的时候打开。代码里还有限速：每分钟 6 次，每天 60 次（北京时间），次数记在本机。

WorkBuddy 的「助理」如果也要接飞书，请另建一个飞书应用。不要和麦麦卡片的机器人共用同一个 App，否则长连接事件会抢。

## 本机先跑起来

需要 Node.js 20 或更新版本。

```bash
git clone https://github.com/nomadZyt/lark-mcd.git
cd lark-mcd
npm install
cp .env.example .env
```

在 `.env` 里填写飞书应用和主人的 `OWNER_OPEN_ID`。真实查询时再写 `MCD_MCP_TOKEN`，并保持 `DRY_RUN=true`。演示可以维持 `MCD_MODE=mock`，不访问麦当劳。

另外准备两个给 Agent 用的变量。可以写在 `.env`，也可以写在系统环境里：

```bash
LARK_MCD_AGENT=1
LARK_MCD_HOME=/你的路径/lark-mcd
```

`LARK_MCD_HOME` 是仓库目录。技能被复制到宿主自己的技能目录之后，命令靠它找到仓库，不靠相对路径。

启动飞书机器人。`propose` 发出的卡片要由这个进程接收点击：

```bash
npm start
```

命令：

```bash
node bin/lark-mcd.mjs agent stores --near "上海 人民广场" --json
node bin/lark-mcd.mjs agent menu --store <storeCode> --json
node bin/lark-mcd.mjs agent quote --store <storeCode> --items '[{"code":"1440","qty":1}]' --json
node bin/lark-mcd.mjs agent propose --quote <quoteId> --json
node bin/lark-mcd.mjs agent status --json
```

参数和返回值见 [skills/lark-mcd/references/commands.md](../skills/lark-mcd/references/commands.md)。

打包给 WorkBuddy 上传：

```bash
npm run pack-skill
```

产物是 `dist/lark-mcd-skill.zip`。这个文件不进 git。

## WorkBuddy

WorkBuddy 是主要的接法。技能是一份 `SKILL.md`，由 WorkBuddy 的终端去跑上面的命令。保持「默认权限」，执行命令前会再问你一次。不要开「允许完全访问」。

两种安装方式，选一种。

1. 上传技能包。打开「专家 · 技能 · 连接器」→「技能」→「添加技能」→「上传技能」，选 `dist/lark-mcd-skill.zip`。
2. 复制目录。把仓库里的 `skills/lark-mcd/` 复制到 `~/.workbuddy/skills/lark-mcd/`。Windows 是 `%USERPROFILE%\.workbuddy\skills\lark-mcd\`。然后新开一个会话。

不需要配置 mcd-mcp 自定义连接器。Token 由 `lark-mcd` 进程从本机环境变量或仓库 `.env` 读取。图形界面的进程有时拿不到 shell 里 `export` 的变量，所以把 Token 写进仓库 `.env` 更稳。

可以在「设置 → 安全中心 → 命令安全」里把 `lark-mcd agent propose` 设为「询问」。

不要用 WorkBuddy 的定时任务去跑这些命令。

这一版没有 stdio MCP 服务。不要自己写一条 `command` 去直连麦当劳。

## OpenClaw

把技能目录放到仓库的 `skills/lark-mcd`（已经在仓库里），或复制到 `~/.agents/skills/lark-mcd`。

执行策略用询问，不要用完全放行。允许列表里只放查询命令。`propose` 每次都再问一次。

```json5
{
  tools: {
    exec: {
      mode: "ask",
    },
  },
}
```

允许的命令前缀是：

```text
lark-mcd agent stores
lark-mcd agent menu
lark-mcd agent quote
lark-mcd agent status
```

`propose` 不放进自动允许列表。

不要把这个技能加进 heartbeat。OpenClaw 的定时和心跳都不跑 `lark-mcd`。

这一版没有自己的 MCP server，所以不要 `openclaw mcp add` 一条直连 `https://mcp.mcd.cn` 的配置。助手通过执行上面的 CLI 来用技能。

## Hermes Agent

技能目录可以写进 `~/.hermes/config.yaml`：

```yaml
skills:
  external_dirs:
    - /你的路径/lark-mcd/skills
```

审批保持默认的谨慎模式。定时任务不要批准麦麦卡片的命令：

```yaml
approvals:
  mode: smart
  cron_mode: deny
```

不要使用 `/yolo`。不要在 `mcp_servers` 里添加 `https://mcp.mcd.cn`。

Hermes 可能会改写它管理的技能文件。放在 `external_dirs` 里的 `SKILL.md` 如果被改了，用 git 恢复。

## Claude Code

```bash
mkdir -p ~/.claude/skills
ln -s /你的路径/lark-mcd/skills/lark-mcd ~/.claude/skills/lark-mcd
```

同样只通过 CLI 查询和 `propose`。不要在 Claude Code 的 MCP 配置里直连麦当劳。

## 和飞书机器人怎么配合

1. 你在助手里说「查一下附近门店，按老样子核价」。
2. 助手运行 `stores`、`menu`、`quote`，把 JSON 里的价格告诉你。
3. 你同意后，助手运行 `propose`。
4. 飞书私聊出现一张确认卡片。你点「确认下单」或「不吃了」。
5. 演练模式下，卡片说明没有向麦当劳下单。只有 `DRY_RUN=false` 时，这次点击才会调用 `create-order`。

两个机器人不要共用一个飞书应用。麦麦卡片用自己的应用收卡片点击。WorkBuddy 或 OpenClaw 的飞书渠道如果要开，用另一个应用。
