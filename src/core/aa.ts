/**
 * AA 分摊。金额全程用「分」做整数。
 * 每个人的原始小计来自 calculate-price 的 productList.subtotal，同一商品按份数拆开。
 * 订单级优惠、餐具费，以及和实付之间的差额，都按原始小计比例摊进应付金额。
 * 除不尽的分加到发起人身上。所有人应摊之和等于订单实付。
 */

export interface Portion {
  openId: string;
  productCode: string;
  quantity: number;
}

export interface PricedProduct {
  productCode: string;
  productName: string;
  quantity: number;
  subtotalFen: number;
}

export interface ShareLine {
  productCode: string;
  productName: string;
  quantity: number;
  subtotalFen: number;
}

export interface PersonShare {
  openId: string;
  rawFen: number;
  shareFen: number;
  lines: ShareLine[];
}

export function allocateFen(weights: readonly number[], amount: number, initiatorIndex: number): number[] {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error("订单实付必须以分为非负整数");
  }
  if (weights.length === 0) throw new Error("没有可分摊的人");
  if (!Number.isInteger(initiatorIndex) || initiatorIndex < 0 || initiatorIndex >= weights.length) {
    throw new Error("发起人不在分摊名单里");
  }
  for (const weight of weights) {
    if (!Number.isInteger(weight) || weight < 0) throw new Error("原始小计必须以分为非负整数");
  }
  const shares = weights.map(() => 0);
  if (amount === 0) return shares;
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightSum === 0) {
    shares[initiatorIndex] = amount;
    return shares;
  }
  let used = 0;
  for (let index = 0; index < weights.length; index += 1) {
    const share = Math.floor((amount * weights[index]!) / weightSum);
    shares[index] = share;
    used += share;
  }
  shares[initiatorIndex] = (shares[initiatorIndex] ?? 0) + (amount - used);
  return shares;
}

export function splitOrderFen(input: {
  portions: readonly Portion[];
  products: readonly PricedProduct[];
  orderFen: number;
  initiatorOpenId: string;
}): PersonShare[] {
  if (!input.initiatorOpenId) throw new Error("分摊需要发起人");
  const portions = input.portions.filter((portion) => portion.quantity > 0);
  if (portions.length === 0 && input.orderFen === 0) return [];

  const byPerson = new Map<string, PersonShare>();
  const order: string[] = [];
  const touch = (openId: string): PersonShare => {
    const existing = byPerson.get(openId);
    if (existing) return existing;
    const created: PersonShare = { openId, rawFen: 0, shareFen: 0, lines: [] };
    byPerson.set(openId, created);
    order.push(openId);
    return created;
  };

  for (const product of input.products) {
    const mine = portions.filter((portion) => portion.productCode === product.productCode);
    const qty = mine.reduce((sum, portion) => sum + portion.quantity, 0);
    if (qty === 0) continue;
    if (qty !== product.quantity) {
      throw new Error("选票份数和核价份数不一致");
    }
    const weights = mine.map((portion) => portion.quantity);
    const initiatorHere = mine.findIndex((portion) => portion.openId === input.initiatorOpenId);
    const index = initiatorHere >= 0 ? initiatorHere : mine.length;
    const ids = mine.map((portion) => portion.openId);
    const qtyWeights = initiatorHere >= 0 ? weights : [...weights, 0];
    if (initiatorHere < 0) ids.push(input.initiatorOpenId);
    const fenParts = allocateFen(qtyWeights, product.subtotalFen, index);
    ids.forEach((openId, partIndex) => {
      const fen = fenParts[partIndex] ?? 0;
      const person = touch(openId);
      const quantity = mine.find((portion) => portion.openId === openId)?.quantity ?? 0;
      if (quantity > 0) {
        person.lines.push({
          productCode: product.productCode,
          productName: product.productName,
          quantity,
          subtotalFen: fen,
        });
      }
      person.rawFen += fen;
    });
  }

  for (const portion of portions) touch(portion.openId);
  touch(input.initiatorOpenId);

  const people = order.map((openId) => byPerson.get(openId)!);
  const initiatorIndex = people.findIndex((person) => person.openId === input.initiatorOpenId);
  const shares = allocateFen(
    people.map((person) => person.rawFen),
    input.orderFen,
    initiatorIndex,
  );
  people.forEach((person, index) => {
    person.shareFen = shares[index] ?? 0;
  });
  const total = people.reduce((sum, person) => sum + person.shareFen, 0);
  if (total !== input.orderFen) throw new Error("分摊之和不等于订单实付");
  return people.filter((person) => person.rawFen > 0 || person.shareFen !== 0 || person.lines.length > 0);
}
