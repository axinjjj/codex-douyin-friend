import test from "node:test";
import assert from "node:assert/strict";
import { reconcileDouyinOutboundActivity } from "../src/douyin-outbound-ledger.mjs";

const message = (fingerprint, kind, side = "right") => ({ fingerprint, kind, side });

test("ignores registered platform system events in the outbound ledger", () => {
  assert.deepEqual(
    reconcileDouyinOutboundActivity([message("system", "system")]),
    { ok: true, degraded: false, unknownCount: 0, systemCount: 1 },
  );
});

test("degrades on unknown outgoing content without inventing an accountable send", () => {
  assert.deepEqual(
    reconcileDouyinOutboundActivity([message("unknown", "unknown")]),
    { ok: true, degraded: true, unknownCount: 1, systemCount: 0 },
  );
});

test("keeps the exact expected bubble authoritative beside unknown content", () => {
  assert.deepEqual(reconcileDouyinOutboundActivity([
    message("expected", "text"),
    message("unknown", "unknown"),
  ], { expectedFingerprint: "expected" }), {
    ok: true,
    degraded: true,
    unknownCount: 1,
    systemCount: 0,
  });
});

test("blocks only missing or extra accountable outgoing bubbles", () => {
  assert.equal(reconcileDouyinOutboundActivity([
    message("unknown", "unknown"),
  ], { expectedFingerprint: "expected" }).reason, "verified-outbound-missing");
  assert.equal(reconcileDouyinOutboundActivity([
    message("expected", "text"),
    message("extra", "media"),
  ], { expectedFingerprint: "expected" }).reason, "concurrent-outgoing-ambiguous");
  assert.equal(reconcileDouyinOutboundActivity([
    message("extra", "text"),
  ]).reason, "concurrent-outgoing-ambiguous");
});
