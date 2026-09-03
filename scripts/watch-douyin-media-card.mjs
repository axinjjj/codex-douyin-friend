import { CdpClient } from "../src/cdp-client.mjs";
import {
  buildChatIdentityMetadataExpression,
  buildChatMessageMetadataExpression,
  buildLatestIncomingMediaStructureExpression,
  isDouyinChatTarget,
} from "../src/douyin-chat-page.mjs";
import { findNewIncomingMessage } from "../src/douyin-chat-snapshot.mjs";

const port = Number.parseInt(process.env.DOUYIN_DEBUG_PORT || "9229", 10);
const timeoutMs = Number.parseInt(process.env.DOUYIN_MEDIA_WATCH_TIMEOUT_MS || "600000", 10);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
  signal: AbortSignal.timeout(3_000),
});
if (!response.ok) throw new Error(`Douyin debugger returned HTTP ${response.status}.`);
const targets = await response.json();
const target = (targets ?? []).find(isDouyinChatTarget);
if (!target) throw new Error("No debuggable Douyin chat page was found.");

const cdp = new CdpClient(target.webSocketDebuggerUrl);
try {
  await cdp.connect();
  const lockedChat = await cdp.evaluate(buildChatIdentityMetadataExpression());
  if (!lockedChat?.found) throw new Error("The current Douyin chat could not be locked.");
  let previous = await cdp.evaluate(buildChatMessageMetadataExpression());
  console.log(JSON.stringify({
    ok: true,
    event: "media-card-watcher-ready",
    chatLocked: true,
    baselineMessageCount: previous.messageCount,
  }));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    const currentChat = await cdp.evaluate(buildChatIdentityMetadataExpression());
    if (!currentChat?.found || currentChat.fingerprint !== lockedChat.fingerprint) {
      console.log(JSON.stringify({ ok: false, event: "chat-changed-watcher-stopped" }));
      process.exitCode = 4;
      break;
    }

    const current = await cdp.evaluate(buildChatMessageMetadataExpression());
    const incoming = findNewIncomingMessage(previous, current);
    previous = current;
    if (!incoming || incoming.kind === "text") continue;

    const structure = await cdp.evaluate(buildLatestIncomingMediaStructureExpression());
    console.log(JSON.stringify({
      ok: Boolean(structure?.ok),
      event: structure?.ok ? "incoming-media-structure" : "incoming-media-unresolved",
      kind: incoming.kind,
      structure: structure?.ok ? structure.message : undefined,
    }));
    break;
  }

  if (Date.now() >= deadline) {
    console.log(JSON.stringify({ ok: false, event: "media-card-watcher-timeout" }));
    process.exitCode = 2;
  }
} finally {
  cdp.close();
}
