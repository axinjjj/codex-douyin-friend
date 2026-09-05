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
const smokeThreadName = "Codex App Server smoke · disposable";

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

  await client.setThreadName({ threadId, name: smokeThreadName });
  const namedThread = await client.request("thread/read", { threadId, includeTurns: false });
  if (namedThread?.thread?.name !== smokeThreadName) {
    throw new Error("thread/name/set did not persist the smoke-test thread name.");
  }

  let firstTurnId = null;
  const reply = await client.runTurn({
    threadId,
    text: "请按照已加载的人设文件返回规定的验证令牌。",
    onTurnStarted: ({ turnId }) => {
      firstTurnId = turnId;
    },
  });
  if (reply.trim() !== expectedToken) {
    throw new Error("Codex replied, but the persona verification token did not match.");
  }
  const recoveredFirstTurn = await client.readTurn({ threadId, turnId: firstTurnId });
  if (recoveredFirstTurn.status !== "completed"
      || recoveredFirstTurn.text.trim() !== expectedToken) {
    throw new Error("thread/read did not recover the completed smoke-test turn.");
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
  if (resumed.thread.name !== smokeThreadName) {
    throw new Error("The persisted smoke-test thread name was not preserved on resume.");
  }
  let resumedTurnId = null;
  const resumedReply = await client.runTurn({
    threadId,
    text: "请再次只返回人设文件规定的验证令牌。",
    onTurnStarted: ({ turnId }) => {
      resumedTurnId = turnId;
    },
  });
  if (resumedReply.trim() !== expectedToken) {
    throw new Error("The resumed Codex thread did not preserve the persona behavior.");
  }
  const recoveredResumedTurn = await client.readTurn({ threadId, turnId: resumedTurnId });
  if (recoveredResumedTurn.status !== "completed"
      || recoveredResumedTurn.text.trim() !== expectedToken) {
    throw new Error("thread/read did not recover the resumed smoke-test turn.");
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
      threadNamed: true,
      completedTurnRecovered: true,
    }),
  );
} finally {
  if (threadId && !threadDeleted && client.process) {
    await client.request("thread/delete", { threadId }).catch(() => {});
  }
  await client.close();
}
