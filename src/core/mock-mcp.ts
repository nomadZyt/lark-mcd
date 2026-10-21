import { readFileSync } from "node:fs";
import { invokeGuarded } from "./mcp-client.js";
import { McpGuard } from "./guard.js";
import { formatYuanFromFen, yuanStringToFen } from "./money.js";
import { parseMealsPayload } from "./parse.js";
import { fixturePath } from "./paths.js";
import type { BusinessEnvelope, GuardMeta, MealInfo, Trigger } from "./types.js";
import type { McpClient } from "./mcp-client.js";

const NOTICE = "演示数据，来源于 2026-10-19 的一次只读调用并已脱敏和裁剪；价格不代表实时价格。";

export interface DemoStore {
  storeCode: string;
  storeName: string;
  businessStatus: boolean;
  reservation: boolean;
  reservationTimeOptions: { date: string; today: boolean; reservationOptionText: string }[];
}

export interface DemoOrder {
  orderId: string;
  orderType: string;
  createTime: string;
  beType: string;
  beCode: string;
  storeCode: string;
  storeName: string;
  orderStatus: string;
  orderProductList: {
    productCode: string;
    productName: string;
    quantity: number;
    comboItemList: unknown[];
  }[];
  realTotalAmount: string;
}

export interface Fixtures {
  notice: string;
  meals: MealInfo[];
  frequentCode?: string;
  stores: DemoStore[];
  orders: DemoOrder[];
}

export interface PricedLine {
  productCode: string;
  productName: string;
  quantity: number;
  originalSubtotal: number;
  subtotal: number;
}

export interface PricedBasket {
  price: number;
  discount: number;
  tablewarePrice: number;
  productList: PricedLine[];
  takeWayList: { code: string; title: string; subtitle: string }[];
}

const TAKE_WAYS = [
  { code: "eat-in", title: "堂食", subtitle: "店内用餐" },
  { code: "locker-out", title: "外带", subtitle: "店外取餐柜" },
];

export function loadFixtures(): Fixtures {
  const menu = JSON.parse(readFileSync(fixturePath("menu.json"), "utf8")) as {
    meals: Record<string, unknown> | unknown[];
    frequent?: unknown;
  };
  const stores = JSON.parse(readFileSync(fixturePath("stores.json"), "utf8")) as { stores: DemoStore[] };
  const orders = JSON.parse(readFileSync(fixturePath("order-list.json"), "utf8")) as {
    data: { list: DemoOrder[] };
  };
  const parsed = parseMealsPayload({ meals: menu.meals, frequent: menu.frequent });
  return {
    notice: NOTICE,
    meals: parsed.meals,
    frequentCode: parsed.frequentCode,
    stores: stores.stores,
    orders: orders.data.list,
  };
}

export function priceBasket(
  meals: MealInfo[],
  items: { productCode: string; quantity: number }[],
  options: { withOrder: boolean; needTableware: boolean },
): { ok: true; basket: PricedBasket } | { ok: false; envelope: BusinessEnvelope } {
  const byCode = new Map(meals.map((meal) => [meal.code, meal]));
  const productList: PricedLine[] = [];
  let original = 0;
  let current = 0;
  for (const item of items) {
    const meal = byCode.get(item.productCode);
    if (!meal || item.quantity < 1) {
      return {
        ok: false,
        envelope: {
          success: false,
          code: 60006,
          message: "商品已售罄或不可售，换一个商品或检查orderType/beType",
          traceId: "demo-trace",
        },
      };
    }
    const originalUnit = yuanStringToFen(meal.originalPrice);
    const currentUnit = yuanStringToFen(meal.currentPrice);
    const memberPrice = options.withOrder && meal.canWithOrder;
    const unit = memberPrice || !meal.discountType?.startsWith("随单购") ? currentUnit : originalUnit;
    const subtotal = unit * item.quantity;
    const originalSubtotal = originalUnit * item.quantity;
    original += originalSubtotal;
    current += subtotal;
    productList.push({
      productCode: item.productCode,
      productName: meal.name,
      quantity: item.quantity,
      originalSubtotal,
      subtotal,
    });
  }
  const tablewarePrice = options.needTableware ? 100 : 0;
  return {
    ok: true,
    basket: {
      price: current + tablewarePrice,
      discount: original - current,
      tablewarePrice,
      productList,
      takeWayList: TAKE_WAYS,
    },
  };
}

interface CreatedOrder {
  orderId: string;
  payH5Url: string;
  priceFen: number;
  storeName: string;
}

export class MockMcpClient implements McpClient {
  readonly calls: { tool: string; args: Record<string, unknown> }[] = [];
  /** 测试用：拦住真正的回放，好确认卡片回调先返回 toast。 */
  hold: Promise<void> | null = null;
  /** 测试用：这些商品编码在核价时返回 60006，用来模拟当前时段不可售。 */
  unavailableCodes = new Set<string>();
  private readonly created = new Map<string, CreatedOrder>();
  private sequence = 0;

  constructor(
    private readonly guard: McpGuard,
    readonly fixtures: Fixtures,
  ) {}

  async call(
    tool: string,
    args: Record<string, unknown>,
    trigger: Trigger,
    meta?: GuardMeta,
  ): Promise<BusinessEnvelope> {
    return invokeGuarded(this.guard, tool, trigger, meta, async () => {
      if (this.hold) await this.hold;
      this.calls.push({ tool, args });
      return this.dispatch(tool, args);
    });
  }

  private dispatch(tool: string, args: Record<string, unknown>): BusinessEnvelope {
    switch (tool) {
      case "query-nearby-stores":
        return this.nearby(args);
      case "query-meals":
        return this.meals();
      case "calculate-price":
        return this.price(args);
      case "order-list":
        return this.orderList();
      case "create-order":
        return this.create(args);
      case "query-order":
        return this.query(args);
      case "cancel-order":
        return this.cancel(args);
      default:
        return { success: false, code: 400, message: "这个工具不在白名单里" };
    }
  }

  private nearby(args: Record<string, unknown>): BusinessEnvelope {
    if (args.searchType === 1) {
      return {
        success: false,
        code: 600050,
        message: "收藏餐厅列表为空，请您提供城市+关键词进行搜索",
        traceId: "demo-trace-favorites",
      };
    }
    return {
      success: true,
      code: 200,
      message: "请求成功",
      traceId: "demo-trace-stores",
      data: this.fixtures.stores,
    };
  }

  private meals(): BusinessEnvelope {
    const meals: Record<string, unknown> = {};
    for (const meal of this.fixtures.meals) {
      meals[meal.code] = {
        name: meal.name,
        currentPrice: meal.currentPrice,
        originalPrice: meal.originalPrice,
        discountType: meal.discountType ?? null,
        canWithOrder: meal.canWithOrder,
        withOrder: meal.withOrder,
      };
    }
    return {
      success: true,
      code: 200,
      message: "请求成功",
      traceId: "demo-trace-meals",
      data: {
        frequent: this.fixtures.frequentCode ? { code: this.fixtures.frequentCode, tags: ["我的常点"] } : null,
        meals,
      },
    };
  }

  private price(args: Record<string, unknown>): BusinessEnvelope {
    const blocked = this.rejectNonPickup(args);
    if (blocked) return blocked;
    const items = readItems(args.items);
    if (items.some((item) => this.unavailableCodes.has(item.productCode))) {
      return {
        success: false,
        code: 60006,
        message: "商品已售罄或不可售，换一个商品或检查orderType/beType",
        traceId: "demo-trace",
      };
    }
    const priced = priceBasket(this.fixtures.meals, items, {
      withOrder: Boolean(args.withOrder),
      needTableware: args.needTableware === true,
    });
    if (!priced.ok) return priced.envelope;
    return {
      success: true,
      code: 200,
      message: "请求成功",
      traceId: "demo-trace-price",
      data: priced.basket,
    };
  }

  private orderList(): BusinessEnvelope {
    return {
      success: true,
      code: 200,
      message: "请求成功",
      traceId: "demo-trace-order-list",
      data: { list: this.fixtures.orders },
    };
  }

  private create(args: Record<string, unknown>): BusinessEnvelope {
    const blocked = this.rejectNonPickup(args);
    if (blocked) return blocked;
    if (typeof args.takeWayCode !== "string" || !args.takeWayCode) {
      return { success: false, code: 400, message: "到店下单需要 takeWayCode" };
    }
    if ("withOrder" in args && args.withOrder) {
      return { success: false, code: 400, message: "这一版不会随单购买会员卡" };
    }
    const items = readItems(args.items);
    const priced = priceBasket(this.fixtures.meals, items, {
      withOrder: false,
      needTableware: args.needTableware === true,
    });
    if (!priced.ok) return priced.envelope;
    this.sequence += 1;
    const orderId = `DEMO20261019000${this.sequence}`;
    const yuan = formatYuanFromFen(priced.basket.price).replace("¥", "");
    const created: CreatedOrder = {
      orderId,
      payH5Url: "https://example.invalid/lark-mcd/pay-demo",
      priceFen: priced.basket.price,
      storeName: "演示门店 A",
    };
    this.created.set(orderId, created);
    return {
      success: true,
      code: 200,
      message: "请求成功",
      traceId: "demo-trace-create",
      data: {
        orderId,
        payId: "DEMO-PAY",
        payH5Url: created.payH5Url,
        orderDetail: {
          orderStatus: "待支付",
          storeName: created.storeName,
          realTotalAmount: yuan,
          totalAmount: yuan,
          pickupCode: "",
          lockerCode: "",
          orderProductList: priced.basket.productList.map((line) => ({
            productName: line.productName,
            quantity: line.quantity,
          })),
        },
      },
    };
  }

  private query(args: Record<string, unknown>): BusinessEnvelope {
    const orderId = typeof args.orderId === "string" ? args.orderId : "";
    const created = this.created.get(orderId);
    if (!created) {
      return { success: false, code: 404, message: "没有这张演示订单", traceId: "demo-trace-query" };
    }
    return {
      success: true,
      code: 200,
      message: "请求成功",
      traceId: "demo-trace-query",
      data: {
        orderId,
        orderStatus: "已支付",
        storeName: created.storeName,
        realTotalAmount: formatYuanFromFen(created.priceFen).replace("¥", ""),
        pickupCode: "8821",
        lockerCode: "",
        takeWay: "eat-in",
      },
    };
  }

  private cancel(args: Record<string, unknown>): BusinessEnvelope {
    const orderId = typeof args.orderId === "string" ? args.orderId : "";
    if (!this.created.has(orderId)) {
      return { success: false, code: 404, message: "没有这张演示订单", traceId: "demo-trace-cancel" };
    }
    this.created.delete(orderId);
    return {
      success: true,
      code: 200,
      message: "请求成功",
      traceId: "demo-trace-cancel",
      data: { cancelResult: true, orderId },
    };
  }

  private rejectNonPickup(args: Record<string, unknown>): BusinessEnvelope | undefined {
    if (args.orderType !== undefined && args.orderType !== 1) {
      return { success: false, code: 400, message: "这一版只做到店自取" };
    }
    if (args.beType !== undefined && args.beType !== 1) {
      return { success: false, code: 400, message: "这一版只做到店自取" };
    }
    if (args.beCode) {
      return { success: false, code: 400, message: "到店自取不要传 beCode" };
    }
    return undefined;
  }
}

function readItems(value: unknown): { productCode: string; quantity: number }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.productCode !== "string") return [];
    const quantity = typeof record.quantity === "number" ? record.quantity : 1;
    return [{ productCode: record.productCode, quantity }];
  });
}

export function demoGuard(dryRun: boolean, ownerOpenId = "demo-owner"): McpGuard {
  return new McpGuard({ ownerOpenId, dryRun });
}
