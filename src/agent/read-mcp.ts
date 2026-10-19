export interface PublicStore {
  storeCode: string;
  storeName: string;
  businessStatus?: boolean;
}

export interface PublicQuote {
  priceFen: number;
  discountFen: number;
  tablewareFen: number;
  lines: { productCode: string; productName: string; quantity: number; subtotalFen: number }[];
  takeWays: { code: string; title: string }[];
}

export interface PublicOrderItem {
  code: string;
  name: string;
  quantity: number;
}

export interface PublicOrder {
  orderId: string;
  orderStatus: string;
  storeName?: string;
  storeCode?: string;
  createTime?: string;
  total?: string;
  items: PublicOrderItem[];
}

export function readStores(data: unknown): PublicStore[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.storeCode !== "string" || typeof record.storeName !== "string") return [];
    const store: PublicStore = { storeCode: record.storeCode, storeName: record.storeName };
    if (typeof record.businessStatus === "boolean") store.businessStatus = record.businessStatus;
    return [store];
  });
}

export function readPrice(data: unknown): PublicQuote | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  if (typeof record.price !== "number" || !Number.isInteger(record.price) || !Array.isArray(record.productList)) {
    return undefined;
  }
  const lines = record.productList.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const line = item as Record<string, unknown>;
    if (typeof line.productCode !== "string" || typeof line.productName !== "string") return [];
    const quantity = typeof line.quantity === "number" && Number.isInteger(line.quantity) ? line.quantity : 1;
    const subtotalFen = typeof line.subtotal === "number" && Number.isInteger(line.subtotal) ? line.subtotal : 0;
    return [{ productCode: line.productCode, productName: line.productName, quantity, subtotalFen }];
  });
  const takeWays = Array.isArray(record.takeWayList)
    ? record.takeWayList.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const way = item as Record<string, unknown>;
        if (typeof way.code !== "string" || typeof way.title !== "string") return [];
        return [{ code: way.code, title: way.title }];
      })
    : [];
  return {
    priceFen: record.price,
    discountFen: typeof record.discount === "number" && Number.isInteger(record.discount) ? record.discount : 0,
    tablewareFen:
      typeof record.tablewarePrice === "number" && Number.isInteger(record.tablewarePrice) ? record.tablewarePrice : 0,
    lines,
    takeWays:
      takeWays.length > 0
        ? takeWays
        : [
            { code: "eat-in", title: "堂食" },
            { code: "locker-out", title: "外带" },
          ],
  };
}

export function readOrderList(data: unknown): PublicOrder[] {
  const list =
    data && typeof data === "object" && Array.isArray((data as { list?: unknown }).list)
      ? (data as { list: unknown[] }).list
      : [];
  return list.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.orderId !== "string") return [];
    const items = Array.isArray(record.orderProductList)
      ? record.orderProductList.flatMap((product) => {
          if (!product || typeof product !== "object") return [];
          const row = product as Record<string, unknown>;
          if (typeof row.productCode !== "string") return [];
          return [
            {
              code: row.productCode,
              name: typeof row.productName === "string" ? row.productName : row.productCode,
              quantity: typeof row.quantity === "number" ? row.quantity : 1,
            },
          ];
        })
      : [];
    const order: PublicOrder = {
      orderId: record.orderId,
      orderStatus: typeof record.orderStatus === "string" ? record.orderStatus : "",
      items,
    };
    if (typeof record.storeName === "string") order.storeName = record.storeName;
    if (typeof record.storeCode === "string") order.storeCode = record.storeCode;
    if (typeof record.createTime === "string") order.createTime = record.createTime;
    if (typeof record.realTotalAmount === "string") order.total = record.realTotalAmount;
    return [order];
  });
}

export function readOrderDetail(data: unknown, fallbackId: string): Record<string, string> {
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const detail: Record<string, string> = {
    orderId: typeof record.orderId === "string" ? record.orderId : fallbackId,
  };
  copyString(detail, "orderStatus", record.orderStatus);
  copyString(detail, "storeName", record.storeName);
  copyString(detail, "storeCode", record.storeCode);
  copyString(detail, "pickupCode", record.pickupCode);
  copyString(detail, "total", record.realTotalAmount);
  return detail;
}

function copyString(target: Record<string, string>, key: string, value: unknown): void {
  if (typeof value === "string" && value) target[key] = value;
}
