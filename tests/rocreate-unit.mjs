// Self-check: task 26 RoCreate offline logic -- crypto round-trip, module rewriter
// corpus, map manifest, CSRF-retry against a mock, locked-tool refusal, fail-open.
// Pure Node, NO network, NO Studio. Run after `npm run build`:
//   node tests/rocreate-unit.mjs
import assert from "node:assert";
import {
  encryptCookie,
  decryptCookie,
  isUnlocked,
  useCookie,
} from "../dist/rocreate-secrets.js";
import { previewRewrite, applyRewrite, verifyRewrite } from "../dist/rocreate-rewrite.js";
import { CookieClient, mapKey, ocErrorText, grantAssetPermission } from "../dist/rocreate.js";

let n = 0;
function check(name, fn) {
  n++;
  fn();
  console.log(`  ok ${n}: ${name}`);
}
async function acheck(name, fn) {
  n++;
  await fn();
  console.log(`  ok ${n}: ${name}`);
}

// --- crypto: scrypt + AES-256-GCM round-trip ---------------------------------
check("encrypt->decrypt with right password round-trips", () => {
  const cookie = "_|WARNING:-DO-NOT-SHARE-THIS.--sekrit-value-123";
  const blob = encryptCookie(cookie, "hunter2");
  assert.ok(blob.salt && blob.iv && blob.tag && blob.ciphertext, "envelope fields present");
  assert.ok(!blob.ciphertext.includes("sekrit"), "ciphertext is not the plaintext");
  assert.strictEqual(decryptCookie(blob, "hunter2"), cookie);
});
check("wrong password fails cleanly (GCM tag mismatch throws)", () => {
  const blob = encryptCookie("_|WARNING:-DO-NOT-SHARE-THIS.--x", "right");
  assert.throws(() => decryptCookie(blob, "wrong"), "wrong password must throw");
});
check("tampered ciphertext fails", () => {
  const blob = encryptCookie("_|WARNING:-DO-NOT-SHARE-THIS.--x", "pw");
  const bad = { ...blob, ciphertext: Buffer.from("garbage").toString("base64") };
  assert.throws(() => decryptCookie(bad, "pw"));
});

// --- module rewriter corpus --------------------------------------------------
const MODULE = [
  "-- MonetizationIds (75 is a comment, do not touch)",
  "local M = {}",
  "M.Products = {",
  '\t["Seed:Tulip:10"] = 111, -- keyed string has digits 10',
  "\tDormant = 0,",
  "\tGems100 = 222,",
  "\tGems500 = 222,",
  "\tFloatPrice = 3.14,",
  "}",
  "return M",
].join("\n");

check("rewriter: whole-integer value match, zeros untouched, strings/comments masked", () => {
  const map = new Map([
    ["111", "999"],
    ["222", "888"],
  ]);
  const preview = previewRewrite(MODULE, map);
  // 111 once, 222 twice = 3 replacements; the "10" in the key string and "75" in the
  // comment and the 0 dormant and 3.14 float are all untouched.
  assert.strictEqual(preview.counts.replaced, 3, JSON.stringify(preview.counts));
  assert.strictEqual(preview.counts.leftAsZero, 1);
  assert.ok(preview.duplicates.some((d) => d.oldId === "222" && d.lines.length === 2));
});
check("rewriter: apply is byte-preserving except the value digits", () => {
  const map = new Map([["111", "999"], ["222", "888"]]);
  const { text } = applyRewrite(MODULE, map);
  assert.ok(text.includes("Gems100 = 888,"), text);
  assert.ok(text.includes("Gems500 = 888,"), text);
  assert.ok(text.includes('["Seed:Tulip:10"] = 999,'), "keyed string digits preserved, value swapped");
  assert.ok(text.includes("Dormant = 0,"), "zero untouched");
  assert.ok(text.includes("FloatPrice = 3.14,"), "float untouched");
  assert.ok(text.includes("-- MonetizationIds (75 is a comment"), "comment untouched");
  assert.strictEqual(text.split("\n").length, MODULE.split("\n").length, "line count preserved");
});
check("rewriter: verify passes after apply, catches a stray old id", () => {
  const map = new Map([["111", "999"], ["222", "888"]]);
  const { text } = applyRewrite(MODULE, map);
  assert.strictEqual(verifyRewrite(text, map).ok, true);
  // A module where an old id survives must fail verify.
  const stray = "local x = 111\n";
  assert.strictEqual(verifyRewrite(stray, map).ok, false);
});

// --- map key shape -----------------------------------------------------------
check("mapKey is kind:oldId", () => {
  assert.strictEqual(mapKey("audio", "123"), "audio:123");
});

// --- cookie validity gate ----------------------------------------------------
check("CookieClient.looksValid requires the warning prefix", () => {
  assert.strictEqual(CookieClient.looksValid("_|WARNING:-DO-NOT-SHARE-THIS.--abc"), true);
  assert.strictEqual(CookieClient.looksValid("just-a-random-string"), false);
});

// --- CSRF retry dance against a mock fetch -----------------------------------
await acheck("CookieClient does the reactive CSRF retry (403 -> token -> retry)", async () => {
  const origFetch = globalThis.fetch;
  let calls = 0;
  const seenTokens = [];
  globalThis.fetch = async (url, init) => {
    calls++;
    seenTokens.push(init?.headers?.["x-csrf-token"] ?? null);
    if (calls === 1) {
      return new Response("XSRF Token Validation Failed", {
        status: 403,
        headers: { "x-csrf-token": "fresh-token-abc" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const c = new CookieClient("_|WARNING:-DO-NOT-SHARE-THIS.--x");
    const res = await c.fetch("https://example.test/thing", { method: "POST" });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls, 2, "should retry exactly once");
    assert.strictEqual(seenTokens[0], null, "first call has no token");
    assert.strictEqual(seenTokens[1], "fresh-token-abc", "retry carries the fresh token");
  } finally {
    globalThis.fetch = origFetch;
  }
});

// --- locked-session refusal / fail-open when no cookie -----------------------
check("no unlock session -> isUnlocked false, useCookie null (tools must refuse)", () => {
  assert.strictEqual(isUnlocked(), false);
  assert.strictEqual(useCookie(), null);
});

// --- OC error legibility: object error shape must not collapse to [object Object] ---
check("ocErrorText surfaces nested {error:{code,message}} (no [object Object])", () => {
  const t = ocErrorText({ error: { code: "InvalidUniverse", message: "universe not found" } }, "", 400);
  assert.ok(t.includes("universe not found"), t);
  assert.ok(t.includes("InvalidUniverse"), t);
  assert.ok(!/\[object Object\]/.test(t), t);
});
check("ocErrorText surfaces {errors:[{message}]} and {message}", () => {
  assert.ok(ocErrorText({ errors: [{ message: "scope missing", code: 7 }] }, "", 403).includes("scope missing"));
  assert.ok(ocErrorText({ message: "bad request" }, "", 400).includes("bad request"));
});
check("ocErrorText appends the stale-key restart hint on 401/403 only", () => {
  assert.ok(/restart\/reconnect/.test(ocErrorText({ message: "x" }, "", 401)), "401 gets hint");
  assert.ok(/restart\/reconnect/.test(ocErrorText({ message: "x" }, "", 403)), "403 gets hint");
  assert.ok(!/restart\/reconnect/.test(ocErrorText({ message: "x" }, "", 429)), "429 no hint");
});
check("ocErrorText falls back to raw text when body has no known field", () => {
  const t = ocErrorText({}, "Internal Server Error", 500);
  assert.ok(t.includes("Internal Server Error"), t);
});

// --- grant-verify integrity: 200 without the asset in successAssetIds = NOT ok ---
await acheck("grant returning 200 but NOT confirming the asset -> ok:false (unapplied)", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ successAssetIds: [] }), { status: 200 });
  try {
    const r = await grantAssetPermission({ apiKey: "k", assetId: "555", subjectType: "Universe", subjectId: "1" });
    assert.strictEqual(r.ok, false, "unconfirmed grant must be ok:false");
    assert.ok(/did not confirm|asset-permissions:write/.test(r.error ?? ""), r.error);
  } finally {
    globalThis.fetch = orig;
  }
});
await acheck("grant confirming the asset in successAssetIds -> ok:true", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ successAssetIds: [555] }), { status: 200 });
  try {
    const r = await grantAssetPermission({ apiKey: "k", assetId: "555", subjectType: "Universe", subjectId: "1" });
    assert.strictEqual(r.ok, true);
    assert.ok(r.grantedAssetIds.includes("555"));
  } finally {
    globalThis.fetch = orig;
  }
});
await acheck("grant 403 surfaces a legible error with the stale-key hint", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { code: "CannotManageAsset" } }), { status: 403 });
  try {
    const r = await grantAssetPermission({ apiKey: "k", assetId: "5", subjectType: "Universe", subjectId: "1" });
    assert.strictEqual(r.ok, false);
    assert.ok(/restart\/reconnect/.test(r.error ?? ""), r.error);
  } finally {
    globalThis.fetch = orig;
  }
});

console.log(`rocreate-unit self-check: PASS (${n} cases)`);
