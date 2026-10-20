import type { OrderItem, WithOrderArg } from "../core/types.js";

export interface QuoteLine {
  productCode: string;
  productName: string;
  quantity: number;
  subtotalFen: number;
}

export interface PriceQuote {
  priceFen: number;
  discountFen: number;
  tablewareFen: number;
  lines: QuoteLine[];
  takeWays: { code: string; title: string }[];
}

export interface Draft {
  id: string;
  chatId: string;
  storeCode: string;
  storeName: string;
  items: OrderItem[];
  takeWayCode: string;
  needTableware: boolean;
  quote?: PriceQuote;
  quotedAt?: number;
  status: "priced" | "ordered" | "cancelled";
  orderId?: string;
  payH5Url?: string;
  realTotalFen?: number;
  orderStatus?: string;
  pickupCode?: string;
  withOrder?: WithOrderArg;
  discountType?: string;
  eligibleCount: number;
  paybackLines: string[] | null;
  pending: boolean;
  comboDefault: boolean;
}

export class SessionBook {
  private readonly drafts = new Map<string, Draft>();
  private readonly byChat = new Map<string, string>();

  put(draft: Draft): void {
    this.drafts.set(draft.id, draft);
    this.byChat.set(draft.chatId, draft.id);
  }

  get(id: string): Draft | undefined {
    return this.drafts.get(id);
  }
}

export function eligibleWithOrder(items: OrderItem[]): { count: number; withOrder?: WithOrderArg; discountType?: string } {
  const eligible = items.filter((item) => item.canWithOrder && item.withOrder);
  const first = eligible[0];
  return {
    count: eligible.reduce((sum, item) => sum + item.quantity, 0),
    withOrder: first?.withOrder,
    discountType: first?.discountType,
  };
}

export function isCombo(items: OrderItem[]): boolean {
  return items.some(
    (item) => item.productCode.startsWith("990") || (item.name ?? "").includes("套餐") || (item.name ?? "").includes("件套"),
  );
}
