import { useRef } from 'react';
import { is } from '@anupheaus/common';

/**
 * The same reference for as long as `value` stays deep-equal (`is.deepEqual`: DateTimes by instant) to the first value
 * seen, then the new value. For a hook dependency built from props callers pass inline each render: compared by value,
 * without hashing them every render (`Object.hash` walks every nested DateTime's prototype chain).
 */
export function useDeepEqualValue<T>(value: T): T {
  const ref = useRef<{ value: T }>();
  if (ref.current == null || !is.deepEqual(ref.current.value, value)) ref.current = { value };
  return ref.current.value;
}
