// NODE_INTERFACE → Karma transition rules → "An identity holds at most two karma boxes"
import type { BoxRef } from './render.js';

// A karma spend names the own box, the income box only when the own box does
// not cover the spend, and the income box alone when there is no own box
// (NODE_INTERFACE → Karma transition rules).
export function selectKarmaInputs(boxes: readonly BoxRef[], spend: bigint): BoxRef[] {
  const own: BoxRef[] = [];
  const income: BoxRef[] = [];
  for (const b of boxes) {
    if (b.income === true) income.push(b);
    else own.push(b);
  }
  if (own.length > 1) {
    throw new Error(`owner holds ${own.length} unmarked karma boxes; expected at most one`);
  }
  if (income.length > 1) {
    throw new Error(`owner holds ${income.length} income karma boxes; expected at most one`);
  }
  const o = own[0];
  const i = income[0];
  if (o === undefined && i === undefined) {
    throw new Error('owner holds no karma box to spend');
  }
  if (o === undefined) return [i!];
  if (o.value >= spend) return [o];
  if (i === undefined || o.value + i.value < spend) {
    const have = o.value + (i?.value ?? 0n);
    throw new Error(`owner karma insufficient: have ${have}, need ${spend}`);
  }
  return [o, i];
}
