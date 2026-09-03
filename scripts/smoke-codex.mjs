import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CodexAppServerClient,
  instructionSourcesContain,
} from "../src/codex-app-server-client.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const personaDirectory = path.join(projectRoot, "fixtures", "persona");
const expectedInstructionPath = path.join(personaDirectory, "AGENTS.md");
const expectedToken = "CODEX_PERSONA_OK";

let client = new CodexAppServerClient();
let threadId = null;
let threadDeleted = false;
const silencePrivateDiagnostics = (activeClient) => {
  activeClient.on("stderr", () => {
    // App Server diagnostics may contain local paths. Keep smoke output minimal.
  });
};
silencePrivateDiagnostics(client);

try {
  await client.start();
  const threadResult = await client.startThread({ cwd: personaDirectory, ephemeral: false });
  threadId = threadResult?.thread?.id;
  if (!threadId) throw new Error("thread/start did not return a thread id.");
  if (threadResult.thread.ephemeral !== false) {
    throw new Error("thread/start did not create a persistent smoke-test thread.");
  }

  const instructionLoaded = instructionSourcesContain(
    threadResult.instructionSources,
    expectedInstructionPath,
  );
  if (!instructionLoaded) {
    throw new Error("The fixture AGENTS.md was not listed in instructionSources.");
  }

  const reply = await client.runTurn({
    threadId,
    text: "请按照已加载的人设文件返回规定的验证令牌。",
  });
  if (reply.trim() !== expectedToken) {
    throw new Error("Codex replied, but the persona verification token did not match.");
  }

  await client.close();
  client = new CodexAppServerClient();
  silencePrivateDiagnostics(client);
  await client.start();
  const resumed = await client.resumeThread({ threadId, cwd: personaDirectory });
  if (resumed?.thread?.id !== threadId || resumed.thread.ephemeral !== false) {
    throw new Error("thread/resume did not reopen the persistent smoke-test thread.");
  }
  if (!instructionSourcesContain(resumed.instructionSources, expectedInstructionPath)) {
    throw new Error("The fixture AGENTS.md was not loaded on thread/resume.");
  }
  const resumedReply = await client.runTurn({
    threadId,
    text: "请再次只返回人设文件规定的验证令牌。",
  });
  if (resumedReply.trim() !== expectedToken) {
    throw new Error("The resumed Codex thread did not preserve the persona behavior.");
  }

  await client.request("thread/delete", { threadId });
  threadDeleted = true;

  console.log(
    JSON.stringify({
      ok: true,
      appServer: true,
      instructionLoaded: true,
      personaApplied: true,
      persistentThread: true,
      threadResumed: true,
    }),
  );
} finally {
  if (threadId && !threadDeleted && client.process) {
    await client.request("thread/delete", { threadId }).catch(() => {});
  }
  await client.close();
}
