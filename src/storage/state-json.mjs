import { createHash } from "node:crypto";
import { types } from "node:util";

const FLUSH_LENGTH = 64 * 1024;
const STRING_SLICE = 10_000;

function jsonValue(value, key) {
  const type = typeof value;
  if (value !== null && (type === "object" || type === "function" || type === "bigint")) {
    const toJSON = value.toJSON;
    if (typeof toJSON === "function") value = Reflect.apply(toJSON, value, [key]);
  }
  if (types.isNumberObject(value)) return +value;
  if (types.isStringObject(value)) return String(value);
  if (types.isBooleanObject(value)) return Boolean.prototype.valueOf.call(value);
  if (types.isBigIntObject(value)) return BigInt.prototype.valueOf.call(value);
  return typeof value === "function" || typeof value === "symbol" ? undefined : value;
}

function* quote(value) {
  if (value.length <= STRING_SLICE) {
    yield JSON.stringify(value);
    return;
  }
  yield '"';
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + STRING_SLICE, value.length);
    // Native escaping must see both halves of a UTF-16 surrogate pair.
    const last = value.charCodeAt(end - 1), next = value.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    yield JSON.stringify(value.slice(start, end)).slice(1, -1);
    start = end;
  }
  yield '"';
}

function* pretty(value, depth, ancestors) {
  if (typeof value === "string") {
    yield* quote(value);
    return;
  }
  if (value === null || typeof value !== "object") {
    yield JSON.stringify(value);
    return;
  }
  if (ancestors.has(value)) throw new TypeError("Converting circular structure to JSON");
  ancestors.add(value);
  const array = Array.isArray(value);
  yield array ? "[" : "{";
  const indentation = "  ".repeat(depth + 1);
  let first = true;
  if (array) {
    const length = value.length;
    for (let i = 0; i < length; i++) {
      yield first ? "\n" : ",\n";
      first = false;
      yield indentation;
      yield* pretty(jsonValue(value[i], String(i)) ?? null, depth + 1, ancestors);
    }
  } else {
    for (const key of Object.keys(value)) {
      const child = jsonValue(value[key], key);
      if (child === undefined) continue;
      yield first ? "\n" : ",\n";
      first = false;
      yield indentation;
      yield* quote(key);
      yield ": ";
      yield* pretty(child, depth + 1, ancestors);
    }
  }
  if (!first) yield `\n${"  ".repeat(depth)}`;
  yield array ? "]" : "}";
  ancestors.delete(value);
}

function* chunks(fragments) {
  let pending = "";
  for (const fragment of fragments) {
    pending += fragment;
    if (pending.length < FLUSH_LENGTH) continue;
    yield pending;
    pending = "";
  }
  if (pending) yield pending;
}

function* prettyState(state) {
  yield* pretty(jsonValue(state, ""), 0, new Set());
  yield "\n";
}

function* canonical(value, undefinedText) {
  if (typeof value === "string") {
    yield* quote(value);
  } else if (value === null || typeof value !== "object") {
    yield JSON.stringify(value) ?? undefinedText;
  } else if (Array.isArray(value)) {
    yield "[";
    for (let i = 0; i < value.length; i++) {
      if (i > 0) yield ",";
      // The historical canonical hash joins absent array values as empty fields.
      yield* canonical(value[i], "");
    }
    yield "]";
  } else {
    yield "{";
    let first = true;
    for (const key of Object.keys(value).sort()) {
      if (!first) yield ",";
      first = false;
      yield* quote(key);
      yield ":";
      yield* canonical(value[key], "undefined");
    }
    yield "}";
  }
}

// The migration ledger already records hashObject digests. Stream the identical canonical bytes.
export function hashCanonicalState(value) {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("The canonical value is not hashable.");
  }
  const hash = createHash("sha256");
  for (const chunk of chunks(canonical(value, ""))) hash.update(chunk, "utf8");
  return hash.digest("hex");
}

export function identifyPrettyState(state) {
  const hash = createHash("sha256");
  let size = 0;
  for (const chunk of chunks(prettyState(state))) {
    hash.update(chunk, "utf8");
    size += Buffer.byteLength(chunk, "utf8");
  }
  return { size, sha256: hash.digest("hex") };
}

// Keep the existing two-space JSON format and hash the actual UTF-8 chunks.
export async function writeStateJson(handle, state) {
  const hash = createHash("sha256");
  let size = 0;
  for (const chunk of chunks(prettyState(state))) {
    const bytes = Buffer.from(chunk, "utf8");
    await handle.writeFile(bytes);
    hash.update(bytes);
    size += bytes.length;
  }
  return { size, sha256: hash.digest("hex") };
}
