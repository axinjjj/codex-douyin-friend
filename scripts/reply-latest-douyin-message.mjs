import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";
import { CdpClient } from "../src/cdp-client.mjs";
import {
  buildChatMessageMetadataExpression,
  buildReadLatestIncomingTextExpression,
  isDouyinChatTarget,
} from "../src/douyin-chat-page.mjs";
import {
  generateDouyinReply,
  sendAndVerifyDouyinReply,
  startVerifiedPersonaThread,
} from "../src/douyin-bridge-runtime.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const expectedPersonaPath = path.join(os.homedir(), ".codex", "AGENTS.md");
const port = Number.parseInt(process.env.DOUYIN_DEBUG_PORT || "9229", 10);
const sendEnabled = process.env.DOUYIN_SEND_ENABLED === "true";
const model = process.env.CODEX_DOUYIN_MODEL || "gpt-5.6-sol";
const effort = process.env.CODEX_DOUYIN_EFFORT || "xhigh";

const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
  signal: AbortSignal.timeout(3_000),
});
if (!response.ok) throw new Error(`Douyin debugger returned HTTP ${response.status}.`);
const targets = await response.json();
const target = (targets ?? []).find(isDouyinChatTarget);
if (!target) throw new Error("No debuggable Douyin chat page was found.");

const cdp = new CdpClient(target.webSocketDebuggerUrl);
const codex = new CodexAppServerClient();
codex.on("stderr", () => {
  // Diagnostics can contain local paths or prompt context. Keep them private.
});

try {
  await cdp.connect();
  const inbound = await cdp.evaluate(buildReadLatestIncomingTextExpression());
  if (!inbound?.ok || typeof inbound.text !== "string") {
    throw new Error("No readable incoming Douyin text message was found.");
  }

  const beforeSend = await cdp.evaluate(buildChatMessageMetadataExpression());
  const runtime = await startVerifiedPersonaThread({
    codex,
    cwd: projectRoot,
    expectedPersonaPath,
    model,
    effort,
  });
  const reply = await generateDouyinReply({
    codex,
    threadId: runtime.threadId,
    inboundText: inbound.text,
    model: runtime.model,
    effort: runtime.effort,
  });

  if (!sendEnabled) {
    console.log(JSON.stringify({
      ok: true,
      personaLoaded: true,
      replyGenerated: true,
      replyLength: reply.length,
      model: runtime.model,
      effort: runtime.effort,
      sendEnabled: false,
    }));
    process.exitCode = 0;
  } else {
    const { outgoing, afterSend } = await sendAndVerifyDouyinReply({
      cdp,
      reply,
      beforeSend,
    });

    console.log(JSON.stringify({
      ok: Boolean(outgoing),
      personaLoaded: true,
      replyGenerated: true,
      replyLength: reply.length,
      model: runtime.model,
      effort: runtime.effort,
      sendEnabled: true,
      sendVerified: Boolean(outgoing),
      messageCount: afterSend.messageCount,
    }));
    if (!outgoing) process.exitCode = 3;
  }
} finally {
  await codex.close();
  cdp.close();
}
