export interface LineItem {
  sku: string;
  unitPrice: number;
  quantity: number;
}

/** Money is kept in cents end to end; this rounds once, at the edge. */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function subtotal(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + toCents(item.unitPrice) * item.quantity, 0);
}

export function total(items: LineItem[], taxRate: number): number {
  const net = subtotal(items);
  return net + Math.round(net * taxRate);
}
