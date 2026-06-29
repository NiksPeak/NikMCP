// Self-check: a >1 MB command result, sliced with the SAME algorithm the plugin uses
// (init.server.luau postResult, 700 KB), must reassemble BYTE-IDENTICAL through the
// bridge's acceptChunk -- and every per-chunk POST body must stay under PostAsync's
// 1024 KB cap. Run after `npm run build`:  node tests/chunk-reassembly.mjs
import assert from "node:assert";
import { acceptChunk, sweepChunks } from "../dist/bridge.js";

const CHUNK_SIZE = 700 * 1024; // must match init.server.luau
const POST_CAP = 1024 * 1024; // HttpService:PostAsync hard limit

// A capture-shaped result: a big base64-ish rgba blob (the real oversized driver).
const big = "A".repeat(2_000_000);
const result = { ok: true, result: { rgba: big, width: 1272, height: 540 }, id: "chunk-test-1" };
const payload = JSON.stringify(result);
assert.ok(payload.length > POST_CAP, `payload should exceed 1 MB to exercise chunking (got ${payload.length})`);

// Slice exactly as the plugin does.
const total = Math.ceil(payload.length / CHUNK_SIZE);
assert.ok(total > 1, "should produce multiple chunks");
const chunks = [];
for (let seq = 0; seq < total; seq++) {
  chunks.push({ id: result.id, seq, total, part: payload.slice(seq * CHUNK_SIZE, (seq + 1) * CHUNK_SIZE) });
}

// Every per-chunk POST body must fit under the 1024 KB cap (the whole point).
for (const c of chunks) {
  const body = JSON.stringify({ id: c.id, seq: c.seq, total: c.total, part: c.part });
  const bytes = Buffer.byteLength(body, "utf8");
  assert.ok(bytes <= POST_CAP, `chunk ${c.seq} body ${bytes} exceeds the ${POST_CAP} cap`);
}

// Feed OUT OF ORDER (reversed) -> reassembly must be order-independent.
let assembled = null;
for (const c of [...chunks].reverse()) {
  const r = acceptChunk(c.id, c.seq, c.total, c.part);
  if (r) assembled = r;
}
assert.ok(assembled, "reassembly should complete once all parts arrive");

// Byte-identical: the reassembled JSON must equal the original payload exactly.
assert.strictEqual(JSON.stringify(assembled), payload, "reassembled payload must be byte-identical");
assert.strictEqual(assembled.result.rgba, big, "rgba must round-trip byte-identical");

// Duplicate chunks must not corrupt or double-count (a resent part is ignored).
const dupPayload = JSON.stringify({ ok: true, id: "dup", note: "x" });
const mid = Math.ceil(dupPayload.length / 2);
const dp0 = dupPayload.slice(0, mid);
const dp1 = dupPayload.slice(mid);
assert.strictEqual(acceptChunk("dup", 0, 2, dp0), null);
assert.strictEqual(acceptChunk("dup", 0, 2, dp0), null); // duplicate seq 0 -> still incomplete
const dupDone = acceptChunk("dup", 1, 2, dp1);
assert.ok(dupDone, "reassembly completes after the real second chunk");
assert.strictEqual(JSON.stringify(dupDone), dupPayload, "duplicate did not corrupt reassembly");

// Orphan sweep: an incomplete partial is dropped after the TTL.
acceptChunk("orphan", 0, 3, "p0");
const dropped = sweepChunks(Date.now() + 61_000);
assert.ok(dropped >= 1, "sweep should drop the orphaned partial");

console.log(`chunk-reassembly self-check: PASS (payload ${payload.length} bytes -> ${total} chunks, byte-identical, cap respected, orphan swept)`);
