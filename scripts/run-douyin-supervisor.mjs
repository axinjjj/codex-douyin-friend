import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";
import { createDouyinControlServer } from "../src/douyin-control-server.mjs";
import {
  acquireSupervisorLock,
  createDouyinSupervisor,
} from "../src/douyin-supervisor.mjs";

function resolveCodexBinArgument(argv) {
  const flag = "--codex-bin";
  const positions = argv
    .map((value, index) => (value === flag ? index : -1))
    .filter((index) => index >= 0);
  if (positions.length === 0) return null;
  if (positions.length !== 1 || positions[0] !== 0 || argv.length !== 2 || !argv[1]) {
    throw new Error("The supervisor accepts only one --codex-bin path argument.");
  }
  return path.resolve(argv[1]);
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const codexBinArgument = resolveCodexBinArgument(process.argv.slice(2));
if (codexBinArgument) process.env.CODEX_BIN = codexBinArgument;
const logDirectory = path.join(projectRoot, ".runtime", "logs");
const logPath = path.join(logDirectory, "supervisor.jsonl");
const previousLogPath = path.join(logDirectory, "supervisor.previous.jsonl");
const MAX_LOG_BYTES = 1024 * 1024;

function safeStatusEvent(status) {
  return {
    at: new Date().toISOString(),
    event: "supervisor-status",
    supervisor: status.supervisor,
    edge: status.edge,
    bridge: status.bridge,
    appServer: status.appServer,
    audio: status.audio,
    phase: status.phase,
    model: status.model,
    effort: status.effort,
    sendEnabled: status.sendEnabled,
    mediaReactionEnabled: status.mediaReactionEnabled,
    lastLatencyMs: status.lastLatencyMs,
    contextUsage: status.contextUsage,
    compaction: status.compaction,
    restartAttempt: status.restartAttempt,
    lastError: status.lastError,
  };
}

async function createBoundedStatusLogger() {
  await fs.mkdir(logDirectory, { recursive: true });
  let size = await fs.stat(logPath).then((value) => value.size, () => 0);
  let pending = Promise.resolve();
  const append = (event) => {
    pending = pending.then(async () => {
      const line = `${JSON.stringify(event)}\n`;
      const bytes = Buffer.byteLength(line);
      if (size + bytes > MAX_LOG_BYTES) {
        await fs.rm(previousLogPath, { force: true });
        await fs.rename(logPath, previousLogPath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
        size = 0;
      }
      await fs.appendFile(logPath, line, "utf8");
      size += bytes;
    }).catch(() => {});
    return pending;
  };
  return { append, flush: () => pending };
}

async function listAvailableModels() {
  const codex = new CodexAppServerClient();
  codex.on("stderr", () => {});
  try {
    await codex.start();
    const result = await codex.request("model/list", { limit: 100, includeHidden: true });
    return result?.data ?? [];
  } finally {
    await codex.close();
  }
}

const statusLogger = await createBoundedStatusLogger();
let lock = null;
let supervisor = null;
let dashboard = null;
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await dashboard?.close().catch(() => {});
  await supervisor?.close().catch(() => {});
  await lock?.close().catch(() => {});
  await statusLogger.flush();
}

try {
  lock = await acquireSupervisorLock();
  supervisor = await createDouyinSupervisor({
    projectRoot,
    listModelsFn: listAvailableModels,
  });
  supervisor.on("status", (status) => statusLogger.append(safeStatusEvent(status)));
  dashboard = createDouyinControlServer({ controller: supervisor });
  const url = await dashboard.listen();
  await statusLogger.append({
    at: new Date().toISOString(),
    event: "supervisor-ready",
    controlUrl: url,
  });
  console.log(JSON.stringify({ ok: true, event: "supervisor-ready", controlUrl: url }));
  await supervisor.start();
  process.once("SIGINT", () => shutdown().finally(() => { process.exitCode = 0; }));
  process.once("SIGTERM", () => shutdown().finally(() => { process.exitCode = 0; }));
} catch {
  await statusLogger.append({
    at: new Date().toISOString(),
    event: "supervisor-fatal",
    reason: "startup-failed",
  });
  await shutdown();
  console.error(JSON.stringify({ ok: false, event: "supervisor-fatal", reason: "startup-failed" }));
  process.exitCode = 1;
}
