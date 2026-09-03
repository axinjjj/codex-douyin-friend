import readline from "node:readline";

const MAX_COMMAND_BYTES = 4_096;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const ALLOWED_COMMANDS = new Set(["compact", "status", "stop"]);

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
