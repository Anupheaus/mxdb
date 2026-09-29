import { is } from '@anupheaus/common';

function deepFreeze(value: unknown, seen: WeakSet<object>): void {
  // Already frozen: the freeze is always deep, so everything under it is too — a record the collection has delivered
  // before costs nothing on each later change burst
  if (value == null || typeof value !== 'object' || Object.isFrozen(value) || seen.has(value)) return;
  // Only plain data: a class instance (a luxon DateTime caches what it works out on itself) is left alone
  if (!Array.isArray(value) && !is.plainObject(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
}

/**
 * Freezes, in a development build only (`NODE_ENV` `development`), the arrays and plain objects of a result a live
 * request delivers — so code that mutates a delivered record throws where it does it, instead of silently corrupting
 * what the collection holds. Delivered records ARE the collection's own objects, and both the collection's
 * `upsert` (a deep-equal early return) and live requests (the last delivered result, compared by value) rely on them
 * never changing in place. Class instances inside (DateTimes) are left alone. Anything else: returned untouched.
 */
export function freezeInDevelopment<T>(value: T): T {
  if (process.env.NODE_ENV !== 'development') return value;
  deepFreeze(value, new WeakSet());
  return value;
}
