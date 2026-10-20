export type ActionName =
  | "store.search"
  | "store.pick"
  | "old-usual"
  | "swap"
  | "payback"
  | "reprice"
  | "confirm"
  | "refresh"
  | "cancel"
  | "agent.stores"
  | "agent.menu"
  | "agent.quote"
  | "agent.status"
  | "group.start"
  | "group.close";

export interface Trigger {
  kind: "message" | "card" | "agent";
  eventId: string;
  operatorOpenId: string;
  action: ActionName;
}

export interface WithOrderArg {
  cardId?: string;
  cardType?: number;
  membershipCode?: string;
  membershipSpecId?: string;
}

export interface OrderItem {
  productCode: string;
  quantity: number;
  name?: string;
  canWithOrder?: boolean;
  discountType?: string;
  withOrder?: WithOrderArg;
  originalPriceYuan?: string;
  memberPriceYuan?: string;
}

export interface MealInfo {
  code: string;
  name: string;
  currentPrice: string;
  originalPrice: string;
  discountType?: string;
  canWithOrder: boolean;
  withOrder?: WithOrderArg;
}

export interface BusinessEnvelope {
  success: boolean;
  code: number;
  message: string;
  datetime?: string;
  traceId?: string;
  data?: unknown;
  markdown?: string;
}

export interface GuardMeta {
  draftId?: string;
  draftStatus?: "priced" | "ordered" | "cancelled";
  orderId?: string;
  now?: number;
}

export const ENABLED_TOOLS = [
  "query-nearby-stores",
  "query-meals",
  "calculate-price",
  "create-order",
  "cancel-order",
  "query-order",
  "order-list",
] as const;

export type EnabledTool = (typeof ENABLED_TOOLS)[number];

/** 这些写操作不实现。客户端遇到它们直接拒绝，不会发请求。 */
export const REJECTED_WRITE_TOOLS = [
  "auto-bind-coupons",
  "draw-lottery",
  "mall-create-order",
  "party-order-create",
  "delivery-create-address",
] as const;

export const WRITE_TOOLS = ["create-order", "cancel-order"] as const;

export const ACTION_CALL_BUDGET: Record<ActionName, number> = {
  "store.search": 1,
  "store.pick": 0,
  "old-usual": 2,
  swap: 2,
  payback: 2,
  reprice: 1,
  confirm: 1,
  refresh: 1,
  cancel: 1,
  "agent.stores": 1,
  "agent.menu": 1,
  "agent.quote": 1,
  "agent.status": 1,
  "group.start": 1,
  "group.close": 1,
};

export const QUOTE_TTL_MS = 5 * 60 * 1000;
export const REFRESH_COOLDOWN_MS = 10 * 1000;

export const PICKUP_ORDER_TYPE = 1;
export const PICKUP_BE_TYPE = 1;
