// Self-check: the Open Cloud request builder, size pre-flight, and key redactor --
// pure unit test, NO network, NO Studio. Run after `npm run build`:
// node tests/open-cloud-request.mjs
import assert from "node:assert";
import { buildAssetRequest, preflightSize, redactKey } from "../dist/open-cloud.js";

// buildAssetRequest: userId variant must match the documented shape exactly,
// with the id stringified.
const userReq = buildAssetRequest("Image", "MyImage", "a desc", { userId: 123 });
assert.deepStrictEqual(userReq, {
  assetType: "Image",
  displayName: "MyImage",
  description: "a desc",
  creationContext: { creator: { userId: "123" } },
});

// groupId variant.
const groupReq = buildAssetRequest("Decal", "MyDecal", undefined, { groupId: 456 });
assert.deepStrictEqual(groupReq, {
  assetType: "Decal",
  displayName: "MyDecal",
  description: undefined,
  creationContext: { creator: { groupId: "456" } },
});

// preflightSize: 20 MB exactly is fine; 20 MB + 1 byte is rejected and names the size.
const CAP = 20 * 1024 * 1024;
assert.strictEqual(preflightSize(CAP), null, "exactly 20 MB should be accepted");
const err = preflightSize(CAP + 1);
assert.ok(err && /20 MB/.test(err), "over-cap should be rejected with the 20 MB limit named");
assert.ok(err.includes(String(CAP + 1)), "error should include the actual byte count");

// redactKey: scrubs every occurrence; empty key is a no-op.
const key = "sk-super-secret-key";
const text = `request failed with key ${key}; retry with ${key} removed`;
const redacted = redactKey(text, key);
assert.ok(!redacted.includes(key), "key must not appear in the redacted text");
assert.strictEqual((redacted.match(/<redacted>/g) || []).length, 2, "both occurrences should be redacted");
assert.strictEqual(redactKey(text, ""), text, "empty key must be a no-op");

console.log("open-cloud-request self-check: PASS (buildAssetRequest userId/groupId shapes, preflightSize boundary, redactKey scrub + no-op)");
