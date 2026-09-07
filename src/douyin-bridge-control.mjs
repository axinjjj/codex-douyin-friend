import readline from "node:readline";

const MAX_COMMAND_BYTES = 4_096;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const ALLOWED_COMMANDS = new Set(["compact", "status", "stop"]);
const TERMINAL_DISPOSITIONS = new Set(["retry", "recover", "block"]);
const TERMINAL_REASONS = new Set([
  "checkpoint-boundary-unavailable",
  "persisted-work-recovery-required",
  "persisted-recovery-ambiguous",
  "runtime-retry-required",
  "ui-authority-recovery-required",
  "safety-stop-required",
]);
const TERMINAL_PHASES = new Set([
  "starting", "listening", "queued", "processing", "reply-ready", "sending", "degraded",
  "compacting", "blocked", "stopping", "stopped",
]);
const TERMINAL_RECOVERY_PHASES = new Set(["queued"]);
const TERMINAL_BLOCK_PHASES = new Set([
  "processing", "reply-ready", "sending", "compacting", "blocked",
]);
const TERMINAL_SAFETY_EXIT_CODES = new Set([3, 4, 5, 6, 7]);
const TERMINAL_RUNTIME_PHASES = new Set([
  "starting", "listening", "degraded", "stopping", "stopped",
]);

function isValidTerminalTuple({ disposition, reason, phase }) {
  if (reason === "checkpoint-boundary-unavailable" || reason === "safety-stop-required") {
    return disposition === "block";
  }
  if (reason === "persisted-recovery-ambiguous") {
    return disposition === "block" && phase === "starting";
  }
  if (reason === "persisted-work-recovery-required") {
    return disposition === "recover" && phase === "queued";
  }
  if (reason === "ui-authority-recovery-required") {
    return disposition === "recover" && phase === "reply-ready";
  }
  return reason === "runtime-retry-required"
    && disposition === "retry"
    && TERMINAL_RUNTIME_PHASES.has(phase);
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

export function createBridgeTerminalEvent({ disposition, reason, phase }) {
  const event = {
    version: 1,
    event: "bridge-terminal",
    disposition,
    reason,
    phase,
  };
  return parseBridgeTerminalEvent(event);
}

export function parseBridgeTerminalEvent(value) {
  if (!hasExactKeys(value, ["version", "event", "disposition", "reason", "phase"])
      || value.version !== 1
      || value.event !== "bridge-terminal"
      || !TERMINAL_DISPOSITIONS.has(value.disposition)
      || !TERMINAL_REASONS.has(value.reason)
      || !TERMINAL_PHASES.has(value.phase)
      || !isValidTerminalTuple(value)) {
    throw new Error("Bridge terminal event is invalid.");
  }
  return { ...value };
}

export function classifyBridgeTerminalFailure({ errorCode = null, exitCode = null, phase }) {
  if (errorCode === "DOUYIN_CHECKPOINT_BOUNDARY_UNAVAILABLE") {
    return createBridgeTerminalEvent({
      disposition: "block",
      reason: "checkpoint-boundary-unavailable",
      phase,
    });
  }
  if (errorCode === "DOUYIN_RECOVERY_SAFETY_STOP") {
    return createBridgeTerminalEvent({
      disposition: "block",
      reason: "persisted-recovery-ambiguous",
      phase,
    });
  }
  if (TERMINAL_SAFETY_EXIT_CODES.has(exitCode) || TERMINAL_BLOCK_PHASES.has(phase)) {
    return createBridgeTerminalEvent({
      disposition: "block",
      reason: "safety-stop-required",
      phase,
    });
  }
  if (TERMINAL_RECOVERY_PHASES.has(phase)) {
    return createBridgeTerminalEvent({
      disposition: "recover",
      reason: "persisted-work-recovery-required",
      phase,
    });
  }
  return createBridgeTerminalEvent({
    disposition: "retry",
    reason: "runtime-retry-required",
    phase,
  });
}

export function parseBridgeControlCommand(line) {
  if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > MAX_COMMAND_BYTES) {
    throw new Error("Bridge control command exceeds the size limit.");
  }
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Bridge control command is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Bridge control command must be an object.");
  }
  if (value.version !== 1 || !ALLOWED_COMMANDS.has(value.command)) {
    throw new Error("Bridge control command is unsupported.");
  }
  if (!REQUEST_ID_PATTERN.test(value.requestId || "")) {
    throw new Error("Bridge control request id is invalid.");
  }
  return {
    version: 1,
    command: value.command,
    requestId: value.requestId,
  };
}

export function writeBridgeEvent(output, event) {
  if (!output || typeof output.write !== "function") {
    throw new TypeError("A writable bridge event stream is required.");
  }
  output.write(`${JSON.stringify(event)}\n`);
}

export function createBridgeControlChannel({
  input,
  onCommand,
  onInvalid = () => {},
}) {
  if (!input || typeof input.on !== "function") {
    throw new TypeError("A readable bridge control stream is required.");
  }
  if (typeof onCommand !== "function") {
    throw new TypeError("A bridge command handler is required.");
  }
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  reader.on("line", (line) => {
    try {
      const command = parseBridgeControlCommand(line);
      Promise.resolve(onCommand(command)).catch(() => onInvalid("handler-failed"));
    } catch {
      onInvalid("invalid-command");
    }
  });
  return {
    close() {
      reader.close();
    },
  };
}
