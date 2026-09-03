import { CdpClient } from "../src/cdp-client.mjs";
import {
  buildChatMessageMetadataExpression,
  isDouyinChatTarget,
} from "../src/douyin-chat-page.mjs";
import { findNewIncomingMessage } from "../src/douyin-chat-snapshot.mjs";

const port = Number.parseInt(process.env.DOUYIN_DEBUG_PORT || "9229", 10);
const timeoutMs = Number.parseInt(process.env.DOUYIN_WATCH_TIMEOUT_MS || "180000", 10);
const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
  signal: AbortSignal.timeout(3_000),
});

if (!response.ok) throw new Error(`Douyin debugger returned HTTP ${response.status}.`);
const targets = await response.json();
const target = (targets ?? []).find(isDouyinChatTarget);
if (!target) throw new Error("No debuggable Douyin chat page was found.");

const client = new CdpClient(target.webSocketDebuggerUrl);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

try {
  await client.connect();
  let previous = await client.evaluate(buildChatMessageMetadataExpression());
  console.log(JSON.stringify({
    ok: true,
    event: "watch-ready",
    baselineMessageCount: previous.messageCount,
  }));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(750);
    const current = await client.evaluate(buildChatMessageMetadataExpression());
    const incoming = findNewIncomingMessage(previous, current);
    if (incoming) {
      console.log(JSON.stringify({
        ok: true,
        event: "incoming-message-detected",
        kind: incoming.kind,
        textLength: incoming.textLength,
        messageCount: current.messageCount,
      }));
      process.exitCode = 0;
      break;
    }
    previous = current;
  }

  if (Date.now() >= deadline) {
    console.log(JSON.stringify({ ok: false, event: "watch-timeout" }));
    process.exitCode = 2;
  }
} finally {
  client.close();
}
