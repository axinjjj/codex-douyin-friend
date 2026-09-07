export const DOUYIN_OUTBOUND_DEGRADED_REASON = "unknown-outgoing-observed";

function expectedOutgoingMatches(message, expectedFingerprint, expectedQuoteTargetFingerprint) {
  return message.kind === "text"
    && message.fingerprint === expectedFingerprint
    && (expectedQuoteTargetFingerprint === null
      || message.quoteTargetFingerprint === expectedQuoteTargetFingerprint);
}

export function reconcileDouyinOutboundActivity(messages, {
  expectedFingerprint = null,
  expectedQuoteTargetFingerprint = null,
} = {}) {
  const outgoing = (messages ?? []).filter((message) => message.side === "right");
  const accountable = outgoing.filter((message) => (
    message.kind === "text" || message.kind === "media"
  ));
  const unknown = outgoing.filter((message) => message.kind === "unknown");
  const system = outgoing.filter((message) => message.kind === "system");

  if (expectedFingerprint !== null) {
    const expected = accountable.filter((message) => expectedOutgoingMatches(
      message,
      expectedFingerprint,
      expectedQuoteTargetFingerprint,
    ));
    if (expected.length === 0) {
      return {
        ok: false,
        reason: "verified-outbound-missing",
        unknownCount: unknown.length,
        systemCount: system.length,
      };
    }
    if (expected.length !== 1 || accountable.length !== 1) {
      return {
        ok: false,
        reason: "concurrent-outgoing-ambiguous",
        unknownCount: unknown.length,
        systemCount: system.length,
      };
    }
  } else if (accountable.length > 0) {
    return {
      ok: false,
      reason: "concurrent-outgoing-ambiguous",
      unknownCount: unknown.length,
      systemCount: system.length,
    };
  }

  return {
    ok: true,
    degraded: unknown.length > 0,
    unknownCount: unknown.length,
    systemCount: system.length,
  };
}
