export interface LineItem {
  sku: string;
  unitPrice: number;
  quantity: number;
}

export function subtotal(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
}

export function total(items: LineItem[], taxRate: number): number {
  const net = subtotal(items);
  return net + net * taxRate;
}
