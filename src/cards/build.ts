import { formatYuanFromFen } from "../core/money.js";
import type { CardModel, FeishuCard } from "./types.js";

function markdown(content: string): Record<string, unknown> {
  return { tag: "markdown", content };
}

function callbackButton(
  label: string,
  type: "primary" | "default" | "danger",
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    width: "default",
    behaviors: [{ type: "callback", value }],
  };
}

function linkButton(label: string, url: string): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type: "primary",
    width: "default",
    behaviors: [{ type: "open_url", default_url: url }],
  };
}

function card(title: string, template: FeishuCard["header"]["template"], elements: Record<string, unknown>[]): FeishuCard {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: title }, template },
    body: { elements },
  };
}

function lineText(lines: { name: string; quantity: number; subtotalFen: number }[]): string {
  return lines.map((line) => `${line.name} × ${line.quantity}　　${formatYuanFromFen(line.subtotalFen)}`).join("\n");
}

export function buildCard(model: CardModel): FeishuCard {
  switch (model.kind) {
    case "priced":
      return buildPriced(model);
    case "dry-run":
      return buildDryRun(model);
    case "pay":
      return buildPay(model);
    case "paid":
      return buildPaid(model);
    case "confirm-cancel":
      return buildConfirmCancel(model);
    case "stores":
      return buildStores(model);
    case "note":
      return card(model.title, "wathet", [markdown(model.lines.join("\n"))]);
  }
}

function buildPriced(model: Extract<CardModel, { kind: "priced" }>): FeishuCard {
  const elements: Record<string, unknown>[] = [
    markdown(lineText(model.lines)),
    { tag: "hr" },
    markdown(
      [
        `合计 ${formatYuanFromFen(model.totalFen)}（优惠 ${formatYuanFromFen(model.discountFen)}）`,
        model.tablewareFen > 0 ? `餐具 ${formatYuanFromFen(model.tablewareFen)}` : "",
        "以实时核价为准",
        model.comboDefault ? "套餐按默认搭配" : "",
        model.staleNote ?? "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    markdown("取餐方式"),
  ];
  for (const way of model.takeWays) {
    const selected = way.code === model.selectedTakeWay;
    elements.push(
      callbackButton(`${selected ? "●" : "○"} ${way.title}`, selected ? "primary" : "default", {
        a: "order.takeway",
        sid: model.sessionId,
        v: 1,
        takeWay: way.code,
      }),
    );
  }
  elements.push(
    callbackButton(model.needTableware ? "餐具：需要" : "餐具：不需要", "default", {
      a: "order.tableware",
      sid: model.sessionId,
      v: 1,
    }),
  );
  if (model.eligibleCount > 0) {
    elements.push({ tag: "hr" });
    const payback = model.paybackLines ?? [
      `会员卡小算盘：本单有 ${model.eligibleCount} 件可享随单购价`,
      "本工具只做计算，不会替你购买会员卡。",
    ];
    elements.push(markdown(payback.join("\n")));
    elements.push(paybackForm(model.sessionId));
  }
  if (!model.staleNote) {
    elements.push(
      callbackButton("确认下单", "primary", { a: "order.confirm", sid: model.sessionId, v: 1 }),
    );
  } else {
    elements.push(
      callbackButton("重新核价", "primary", { a: "order.reprice", sid: model.sessionId, v: 1 }),
    );
  }
  elements.push(callbackButton("换一换", "default", { a: "order.swap", sid: model.sessionId, v: 1 }));
  elements.push(callbackButton("不吃了", "danger", { a: "order.dismiss", sid: model.sessionId, v: 1 }));
  elements.push(markdown("说明：下单后会给你付款链接，需要你自己付款。"));
  return card(`老样子 · ${model.storeName}（到店自取）`, "orange", elements);
}

function paybackForm(sessionId: string): Record<string, unknown> {
  return {
    tag: "form",
    name: "payback",
    elements: [
      {
        tag: "input",
        name: "card_price",
        placeholder: { tag: "plain_text", content: "卡价（元），按 App 里看到的填写" },
        width: "fill",
      },
      {
        tag: "select_static",
        name: "freq",
        placeholder: { tag: "plain_text", content: "每周大约几次" },
        options: ["1", "2", "3", "5"].map((value) => ({
          text: { tag: "plain_text", content: `每周约 ${value} 次` },
          value,
        })),
      },
      {
        tag: "button",
        name: "submit",
        text: { tag: "plain_text", content: "算一算" },
        type: "primary",
        action_type: "form_submit",
        behaviors: [{ type: "callback", value: { a: "payback.calc", sid: sessionId, v: 1 } }],
      },
    ],
  };
}

function buildDryRun(model: Extract<CardModel, { kind: "dry-run" }>): FeishuCard {
  return card("演练模式 · 没有向麦当劳下单", "wathet", [
    markdown(
      [
        `${model.storeName} · 到店自取 · ${model.takeWayTitle}`,
        lineText(model.lines),
        `合计 ${formatYuanFromFen(model.totalFen)}`,
        "上面是确认后会提交的内容。演练模式没有调用下单接口。",
        "要真实下单，把本机 .env 里的 DRY_RUN 设为 false，重新核价后再点确认。",
        "付款始终在麦当劳页面完成，本工具不经手资金。",
      ].join("\n"),
    ),
    callbackButton("返回卡片", "default", { a: "order.back", sid: model.sessionId, v: 1 }),
  ]);
}

function buildPay(model: Extract<CardModel, { kind: "pay" }>): FeishuCard {
  return card(`已下单 · 待支付　　订单号 ${model.orderTail}`, "orange", [
    markdown(
      [`合计 ${formatYuanFromFen(model.totalFen)}`, model.note ?? "", "付款在麦当劳页面完成，本工具不经手资金。"]
        .filter(Boolean)
        .join("\n"),
    ),
    linkButton("去付款", model.payH5Url),
    callbackButton("我付好了，刷新", "default", { a: "order.refresh", sid: model.sessionId, v: 1 }),
    callbackButton("取消订单", "danger", { a: "order.cancel", sid: model.sessionId, v: 1 }),
  ]);
}

function buildPaid(model: Extract<CardModel, { kind: "paid" }>): FeishuCard {
  const locker = model.lockerCode ? `取餐柜码 ${model.lockerCode}` : "";
  return card(`取餐码 ${model.pickupCode || "待更新"}`, "green", [
    markdown(
      [
        `订单号 ${model.orderTail}`,
        `合计 ${formatYuanFromFen(model.totalFen)}`,
        locker,
        `状态：${model.orderStatus}（以麦当劳 App 显示为准）`,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    callbackButton("再刷新一次", "default", { a: "order.refresh", sid: model.sessionId, v: 1 }),
  ]);
}

function buildConfirmCancel(model: Extract<CardModel, { kind: "confirm-cancel" }>): FeishuCard {
  return card("确认取消这笔订单？", "red", [
    markdown(`订单号 ${model.orderTail}\n取消后如果还想吃，请重新发送「老样子」。`),
    callbackButton("确认取消", "danger", { a: "order.cancel.confirm", sid: model.sessionId, v: 1 }),
    callbackButton("先不取消", "default", { a: "order.back", sid: model.sessionId, v: 1 }),
  ]);
}

function buildStores(model: Extract<CardModel, { kind: "stores" }>): FeishuCard {
  const elements: Record<string, unknown>[] = [
    markdown("选一家作为以后「老样子」的到店自取门店。选定后保存在本机，这次不会下单。"),
  ];
  for (const store of model.stores) {
    elements.push(markdown(store.storeName));
    elements.push(
      callbackButton("选这家", "primary", {
        a: "store.pick",
        v: 1,
        storeCode: store.storeCode,
        storeName: store.storeName,
      }),
    );
  }
  return card("选择门店", "orange", elements);
}

export function collectCardText(card: FeishuCard): string {
  const chunks: string[] = [card.header.title.content];
  const walk = (value: unknown): void => {
    if (typeof value === "string") chunks.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(card.body.elements);
  return chunks.join("\n");
}
