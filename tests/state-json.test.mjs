import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { hashObject } from "../src/domain/hash.mjs";
import { cloneState } from "../src/storage/clone-state.mjs";
import { hashCanonicalState, identifyPrettyState, writeStateJson } from "../src/storage/state-json.mjs";

test("state serialization is byte-exact across bounded writes and UTF-16 boundaries", async () => {
  const state = {
    "01": "numeric-looking key",
    key: { '\u0000\n\uD800"': "escaped key", empty: {}, emptyArray: [], skipped: undefined },
    aliased: [null, undefined, , Number.NaN, Number.POSITIVE_INFINITY, -0, new Date("2026-11-21T00:00:00Z")],
    conversions: [new Number(4), new Boolean(false), new String("string"), { toJSON: key => ({ key }) }],
    body: `${"界".repeat(9_999)}😀\uD800 \uDC00\r\n\t\\${"\u0000".repeat(145_000)}`,
  };
  state.reused = state.key;
  const parts = [];
  const actual = await writeStateJson({ async writeFile(bytes) { parts.push(bytes); } }, state);
  const expected = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  assert.ok(parts.length > 3);
  assert.ok(parts.every(part => part.length <= 128 * 1024));
  assert.deepEqual(Buffer.concat(parts), expected);
  assert.deepEqual(actual, { size: expected.length, sha256: createHash("sha256").update(expected).digest("hex") });
  assert.deepEqual(identifyPrettyState(state), actual);
  assert.equal(hashCanonicalState(state), hashObject(state));
});

test("state copies isolate mutable nodes and preserve structured clone fallback behavior", () => {
  const shared = { body: "测试".repeat(10_000) };
  const state = { one: shared, two: shared, sparse: [, shared], special: JSON.parse('{"__proto__":{"literal":true}}') };
  const quick = cloneState(state);
  assert.deepEqual(quick, structuredClone(state));
  assert.equal(quick.one, quick.two);
  assert.equal(quick.sparse[1], quick.one);
  assert.equal(0 in quick.sparse, false);
  assert.ok(Object.hasOwn(quick.special, "__proto__"));
  quick.one.body = "updated";
  assert.notEqual(quick.one.body, state.one.body);
  let reads = 0;
  const unusual = { get date() { reads += 1; return new Date("2026-11-21T00:00:00Z"); } };
  assert.equal(cloneState(unusual).date.toISOString(), "2026-11-21T00:00:00.000Z");
  assert.equal(reads, 1);
  assert.throws(() => cloneState({ proxy: new Proxy({}, {}) }), { name: "DataCloneError" });
});
