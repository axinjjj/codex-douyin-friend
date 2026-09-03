import { CdpClient } from "../src/cdp-client.mjs";
import {
  buildChatStructureExpression,
  isDouyinChatTarget,
} from "../src/douyin-chat-page.mjs";

const port = Number.parseInt(process.env.DOUYIN_DEBUG_PORT || "9229", 10);
const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
  signal: AbortSignal.timeout(3_000),
});

if (!response.ok) throw new Error(`Douyin debugger returned HTTP ${response.status}.`);
const targets = await response.json();
const target = (targets ?? []).find(isDouyinChatTarget);
if (!target) throw new Error("No debuggable Douyin chat page was found.");

const client = new CdpClient(target.webSocketDebuggerUrl);
try {
  await client.connect();
  const structure = await client.evaluate(buildChatStructureExpression());
  console.log(JSON.stringify({ ok: true, port, structure }));
} finally {
  client.close();
}
