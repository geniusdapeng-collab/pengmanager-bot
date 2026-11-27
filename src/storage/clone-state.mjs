import { types } from "node:util";

const NATIVE_CLONE_REQUIRED = Symbol("native clone required");

function copy(value, seen) {
  if (typeof value === "function" || typeof value === "symbol") throw NATIVE_CLONE_REQUIRED;
  // JSON strings and other primitives are immutable. Share them without encoding the whole graph.
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (types.isProxy(value)) throw NATIVE_CLONE_REQUIRED;
  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw NATIVE_CLONE_REQUIRED;
  }
  const result = array ? new Array(value.length) : {};
  seen.set(value, result);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, "value")) throw NATIVE_CLONE_REQUIRED;
    const child = copy(descriptor.value, seen);
    if (key === "__proto__") {
      Object.defineProperty(result, key, { value: child, enumerable: true, writable: true, configurable: true });
    } else result[key] = child;
  }
  return result;
}

export function cloneState(value) {
  try { return copy(value, new WeakMap()); }
  catch (error) {
    if (error !== NATIVE_CLONE_REQUIRED && !(error instanceof RangeError)) throw error;
    return structuredClone(value);
  }
}
