import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";
import { ensureDouyinCompanionCwd } from "../src/douyin-companion-runtime.mjs";
import { CdpClient } from "../src/cdp-client.mjs";
import {
  buildChatIdentityMetadataExpression,
  buildReadLatestIncomingTextExpression,
  isDouyinChatTarget,
} from "../src/douyin-chat-page.mjs";
import {
  generateDouyinReply,
  startVerifiedPersonaThread,
} from "../src/douyin-bridge-runtime.mjs";
import { acquireBridgeRunLock } from "../src/douyin-bridge-state.mjs";
import { runDouyinCleanupSteps } from "../src/douyin-runtime-cleanup.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const expectedPersonaPath = path.join(os.homedir(), ".codex", "AGENTS.md");
const port = Number.parseInt(process.env.DOUYIN_DEBUG_PORT || "9229", 10);
const model = process.env.CODEX_DOUYIN_MODEL || "gpt-5.6-sol";
const effort = process.env.CODEX_DOUYIN_EFFORT || "xhigh";
const companionCwd = await ensureDouyinCompanionCwd({ projectRoot });

const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
  signal: AbortSignal.timeout(3_000),
});
if (!response.ok) throw new Error(`Douyin debugger returned HTTP ${response.status}.`);
const targets = await response.json();
const target = (targets ?? []).find(isDouyinChatTarget);
if (!target) throw new Error("No debuggable Douyin chat page was found.");

const cdp = new CdpClient(target.webSocketDebuggerUrl);
const codex = new CodexAppServerClient();
let bridgeLock = null;
codex.on("stderr", () => {
  // Diagnostics can contain local paths or prompt context. Keep them private.
});

try {
  await cdp.connect();
  const lockedChat = await cdp.evaluate(buildChatIdentityMetadataExpression());
  if (!lockedChat?.found) throw new Error("The current Douyin chat could not be locked.");
  bridgeLock = await acquireBridgeRunLock(projectRoot, lockedChat.fingerprint);
  const inbound = await cdp.evaluate(buildReadLatestIncomingTextExpression());
  if (!inbound?.ok || typeof inbound.text !== "string") {
    throw new Error("No readable incoming Douyin text message was found.");
  }

  const runtime = await startVerifiedPersonaThread({
    codex,
    cwd: companionCwd,
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

  console.log(JSON.stringify({
    ok: true,
    event: "text-reply-generated-not-sent",
    personaLoaded: true,
    replyGenerated: true,
    replyLength: reply.length,
    model: runtime.model,
    effort: runtime.effort,
  }));
} finally {
  await runDouyinCleanupSteps([
    () => codex.close(),
    () => cdp.close(),
    () => bridgeLock?.release(),
  ]);
}
