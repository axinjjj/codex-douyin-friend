import { CdpClient } from "../src/cdp-client.mjs";

const port = Number.parseInt(process.env.DOUYIN_DEBUG_PORT || "9229", 10);
const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
  signal: AbortSignal.timeout(3_000),
});

if (!response.ok) throw new Error(`Douyin debugger returned HTTP ${response.status}.`);
const targets = await response.json();
const debuggableTargets = (targets ?? []).filter(
  (target) => typeof target?.webSocketDebuggerUrl === "string",
);

const safeExpression = `(() => ({
  protocol: location.protocol,
  hostPresent: Boolean(location.host),
  readyState: document.readyState,
  elementCount: document.querySelectorAll('*').length,
  iframeCount: document.querySelectorAll('iframe, webview').length,
  inputCount: document.querySelectorAll('input, textarea').length,
  editableCount: document.querySelectorAll('[contenteditable="true"]').length,
  buttonCount: document.querySelectorAll('button, [role="button"]').length
}))()`;

const summaries = [];
for (const target of debuggableTargets) {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await client.connect();
    const page = await client.evaluate(safeExpression);
    summaries.push({ ok: true, type: target.type ?? "unknown", page });
  } catch (error) {
    summaries.push({ ok: false, type: target.type ?? "unknown", error: error.message });
  } finally {
    client.close();
  }
}

console.log(JSON.stringify({ ok: true, port, targetCount: summaries.length, targets: summaries }));
