import { summarizeTargets } from "../src/cdp-client.mjs";

const port = Number.parseInt(process.env.DOUYIN_DEBUG_PORT || "9229", 10);
const endpoint = `http://127.0.0.1:${port}/json/list`;

try {
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const targets = await response.json();
  const safeTargets = summarizeTargets(targets);

  console.log(JSON.stringify({ ok: true, port, targetCount: safeTargets.length, targets: safeTargets }));
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      port,
      reason: "Douyin is not exposing a local debugging endpoint yet.",
      detail: error.message,
    }),
  );
  process.exitCode = 2;
}
