import { CdpClient } from "../src/cdp-client.mjs";
import { isDouyinChatTarget } from "../src/douyin-chat-page.mjs";
import {
  focusAndClearChatEditor,
  replaceChatEditorText,
} from "../src/douyin-editor-control.mjs";

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
  const result = await replaceChatEditorText(client, "Codex输入测试ABC123");
  await focusAndClearChatEditor(client);
  console.log(JSON.stringify({
    ok: Boolean(result?.ok),
    editorAcceptedCompleteProbe: Boolean(result?.ok),
    actualLength: result?.actualLength ?? 0,
    expectedLength: result?.expectedLength ?? 0,
    editorCleared: true,
  }));
  if (!result?.ok) process.exitCode = 2;
} finally {
  client.close();
}
