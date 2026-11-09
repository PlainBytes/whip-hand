import { total, type LineItem } from './cart.ts';

export interface Order {
  id: string;
  items: LineItem[];
  amount: number;
}

export function checkout(id: string, items: LineItem[], taxRate = 0.2): Order {
  if (items.length === 0) throw new Error('an empty cart cannot be checked out');
  return { id, items, amount: total(items, taxRate) };
}
