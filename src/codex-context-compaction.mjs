const COMPACTION_REQUEST_TIMEOUT_MS = 30_000;

export const DEFAULT_CONTEXT_COMPACTION_POLICY = Object.freeze({
  highWatermark: 0.75,
  lowWatermark: 0.5,
  cooldownMs: 5 * 60_000,
  timeoutMs: 120_000,
});

export class CodexContextRecoveryError extends Error {
  constructor(reason, diagnostic) {
    super(`Codex context-window recovery failed (${reason}).`);
    this.name = "CodexContextRecoveryError";
    this.reason = reason;
    this.diagnostic = diagnostic;
  }
}

export class CodexAppServerCompactionError extends Error {
  constructor(kind, { codexErrorCode = null, requestCode = null } = {}) {
    super(`Codex context compaction failed (${kind}).`);
    this.name = "CodexAppServerCompactionError";
    this.kind = kind;
    this.codexErrorCode = codexErrorCode;
    this.requestCode = requestCode;
  }
}

export function extractCodexErrorCode(value) {
  const errorInfo = value?.codexErrorInfo ?? value;
  if (typeof errorInfo === "string") return errorInfo;
  if (!errorInfo || typeof errorInfo !== "object" || Array.isArray(errorInfo)) {
    return null;
  }
  return Object.keys(errorInfo)[0] ?? null;
}

function compactionRequestFailureKind(error) {
  const message = String(error?.message || "");
  if (
    error?.code === -32601 ||
    /method not found|unknown (?:method|variant)|not supported|unsupported/iu.test(message)
  ) {
    return "unsupported";
  }
  if (/timed? out|timeout/iu.test(message)) return "timeout";
  return "request-failed";
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function safeProtocolCode(value) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(value)
    ? value
    : null;
}

export function snapshotThreadTokenUsage(tokenUsage) {
  const contextTokens = finiteNonNegative(tokenUsage?.last?.totalTokens);
  const modelContextWindow = finiteNonNegative(tokenUsage?.modelContextWindow);
  if (contextTokens === null || !modelContextWindow) return null;
  return {
    contextTokens,
    modelContextWindow,
    ratio: contextTokens / modelContextWindow,
  };
}

function validatePolicy({ highWatermark, lowWatermark, cooldownMs, timeoutMs }) {
  if (
    !Number.isFinite(highWatermark) ||
    !Number.isFinite(lowWatermark) ||
    lowWatermark < 0 ||
    highWatermark <= lowWatermark ||
    highWatermark > 1
  ) {
    throw new Error("Context compaction watermarks must satisfy 0 <= low < high <= 1.");
  }
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
    throw new Error("Context compaction cooldown must be non-negative.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Context compaction timeout must be positive.");
  }
}

export function resolveContextCompactionPolicy(environment = process.env) {
  const readNumber = (name, fallback) => {
    const value = environment[name];
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number.`);
    return parsed;
  };
  const policy = {
    highWatermark: readNumber(
      "CODEX_DOUYIN_COMPACTION_HIGH_WATERMARK",
      DEFAULT_CONTEXT_COMPACTION_POLICY.highWatermark,
    ),
    lowWatermark: readNumber(
      "CODEX_DOUYIN_COMPACTION_LOW_WATERMARK",
      DEFAULT_CONTEXT_COMPACTION_POLICY.lowWatermark,
    ),
    cooldownMs: readNumber(
      "CODEX_DOUYIN_COMPACTION_COOLDOWN_MS",
      DEFAULT_CONTEXT_COMPACTION_POLICY.cooldownMs,
    ),
    timeoutMs: readNumber(
      "CODEX_DOUYIN_COMPACTION_TIMEOUT_MS",
      DEFAULT_CONTEXT_COMPACTION_POLICY.timeoutMs,
    ),
  };
  validatePolicy(policy);
  return policy;
}

export class CodexContextCompactionManager {
  constructor({
    codex,
    threadId,
    highWatermark = DEFAULT_CONTEXT_COMPACTION_POLICY.highWatermark,
    lowWatermark = DEFAULT_CONTEXT_COMPACTION_POLICY.lowWatermark,
    cooldownMs = DEFAULT_CONTEXT_COMPACTION_POLICY.cooldownMs,
    timeoutMs = DEFAULT_CONTEXT_COMPACTION_POLICY.timeoutMs,
    now = Date.now,
    onDiagnostic = () => {},
    onUsage = () => {},
    onOperationStart = () => {},
    onOperationEnd = () => {},
  }) {
    if (!codex || typeof codex.on !== "function") {
      throw new Error("A notification-capable Codex client is required.");
    }
    if (!threadId) throw new Error("A Codex thread id is required.");
    validatePolicy({ highWatermark, lowWatermark, cooldownMs, timeoutMs });

    this.codex = codex;
    this.threadId = threadId;
    this.highWatermark = highWatermark;
    this.lowWatermark = lowWatermark;
    this.cooldownMs = cooldownMs;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.onDiagnostic = onDiagnostic;
    this.onUsage = onUsage;
    this.onOperationStart = onOperationStart;
    this.onOperationEnd = onOperationEnd;
    this.latestUsage = null;
    this.serverStatus = "unknown";
    this.activityDepth = 0;
    this.armed = true;
    this.unsupported = false;
    this.lastCompactionStartedAt = Number.NEGATIVE_INFINITY;
    this.compactionPromise = null;
    this.onNotification = (message) => this.#handleNotification(message);
    this.codex.on("notification", this.onNotification);
  }

  close() {
    this.codex.off("notification", this.onNotification);
  }

  get usage() {
    return this.latestUsage ? { ...this.latestUsage } : null;
  }

  get isIdle() {
    return (
      this.activityDepth === 0 &&
      this.serverStatus === "idle" &&
      this.compactionPromise === null
    );
  }

  get policy() {
    return {
      highWatermark: this.highWatermark,
      lowWatermark: this.lowWatermark,
      cooldownMs: this.cooldownMs,
      timeoutMs: this.timeoutMs,
    };
  }

  waitForIdle(timeoutMs = 5_000) {
    if (this.serverStatus !== "active") return Promise.resolve(true);
    return this.#waitForServerIdle(timeoutMs);
  }

  async withActivity(kind, operation) {
    if (typeof operation !== "function") throw new TypeError("Activity operation must be a function.");
    if (this.compactionPromise) await this.compactionPromise;
    this.activityDepth += 1;
    try {
      return await operation();
    } finally {
      this.activityDepth -= 1;
    }
  }

  async runTurn(params) {
    if (!(await this.waitForIdle())) {
      const diagnostic = this.#emitDiagnostic({
        ok: false,
        event: "context-window-recovery-failed",
        reason: "thread-not-idle",
        retryCount: 0,
      });
      throw new CodexContextRecoveryError("thread-not-idle", diagnostic);
    }
    const firstAttempt = await this.#executeObservedTurn(params);
    if (firstAttempt.ok) return firstAttempt.reply;
    if (firstAttempt.codexErrorCode !== "contextWindowExceeded") {
      throw firstAttempt.error;
    }

    await this.#waitForServerIdle(Math.min(this.timeoutMs, 5_000));
    const recovery = await this.#beginCompaction("context-window-exceeded");
    if (!recovery.ok) {
      throw new CodexContextRecoveryError(recovery.reason, recovery.diagnostic);
    }
    if (!(await this.waitForIdle())) {
      const diagnostic = this.#emitDiagnostic({
        ok: false,
        event: "context-window-recovery-failed",
        reason: "thread-not-idle-after-compaction",
        retryCount: 0,
      });
      throw new CodexContextRecoveryError("thread-not-idle-after-compaction", diagnostic);
    }

    const retry = await this.#executeObservedTurn(params);
    if (retry.ok) {
      this.#emitDiagnostic({
        ok: true,
        event: "context-window-recovery-completed",
        retryCount: 1,
      });
      return retry.reply;
    }

    const reason = retry.codexErrorCode === "contextWindowExceeded"
      ? "context-window-exceeded-after-retry"
      : "retry-failed";
    const diagnostic = this.#emitDiagnostic({
      ok: false,
      event: "context-window-recovery-failed",
      reason,
      retryCount: 1,
      codexErrorCode: safeProtocolCode(retry.codexErrorCode),
    });
    throw new CodexContextRecoveryError(reason, diagnostic);
  }

  async #executeObservedTurn(params) {
    let codexErrorCode = null;
    const observeTerminalError = (message) => {
      const notificationParams = message?.params ?? {};
      if (notificationParams.threadId !== this.threadId) return;
      if (message.method === "error" && notificationParams.willRetry === false) {
        codexErrorCode = extractCodexErrorCode(notificationParams.error) ?? codexErrorCode;
        return;
      }
      if (
        message.method === "turn/completed" &&
        notificationParams.turn?.status === "failed"
      ) {
        codexErrorCode =
          extractCodexErrorCode(notificationParams.turn?.error) ?? codexErrorCode;
      }
    };
    this.codex.on("notification", observeTerminalError);
    try {
      const reply = await this.withActivity("turn", () => this.codex.runTurn(params));
      return { ok: true, reply };
    } catch (error) {
      return { ok: false, error, codexErrorCode };
    } finally {
      this.codex.off("notification", observeTerminalError);
    }
  }

  maybeCompact() {
    if (this.compactionPromise) return this.compactionPromise;
    if (this.unsupported) {
      return Promise.resolve({ ok: true, action: "skipped", reason: "unsupported-disabled" });
    }

    const usage = this.latestUsage;
    if (!usage) return Promise.resolve({ ok: true, action: "skipped", reason: "usage-unavailable" });
    if (usage.ratio <= this.lowWatermark) this.armed = true;
    if (usage.ratio < this.highWatermark) {
      return Promise.resolve({ ok: true, action: "skipped", reason: "below-threshold" });
    }
    if (!this.armed) {
      return Promise.resolve({ ok: true, action: "skipped", reason: "hysteresis" });
    }
    if (!this.isIdle) {
      return Promise.resolve({ ok: true, action: "skipped", reason: "busy" });
    }
    if (this.now() - this.lastCompactionStartedAt < this.cooldownMs) {
      return Promise.resolve({ ok: true, action: "skipped", reason: "cooldown" });
    }
    return this.#beginCompaction("threshold");
  }

  compactNow() {
    return this.#beginCompaction("manual");
  }

  #handleNotification(message) {
    const params = message?.params ?? {};
    if (params.threadId !== this.threadId) return;

    if (message.method === "thread/tokenUsage/updated") {
      const usage = snapshotThreadTokenUsage(params.tokenUsage);
      if (!usage) return;
      this.latestUsage = usage;
      if (usage.ratio <= this.lowWatermark) this.armed = true;
      try {
        this.onUsage({ ...usage });
      } catch {
        // Usage reporting must never interrupt the bridge.
      }
      return;
    }

    if (message.method === "thread/status/changed") {
      this.serverStatus = params.status?.type ?? "unknown";
    }
  }

  #waitForServerIdle(timeoutMs) {
    if (this.activityDepth === 0 && this.serverStatus === "idle") {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timeout);
        this.codex.off("notification", onStatus);
      };
      const timeout = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      const onStatus = (message) => {
        if (
          message?.method !== "thread/status/changed" ||
          message.params?.threadId !== this.threadId ||
          message.params?.status?.type !== "idle" ||
          this.activityDepth !== 0
        ) {
          return;
        }
        cleanup();
        resolve(true);
      };
      this.codex.on("notification", onStatus);
    });
  }

  #beginCompaction(trigger) {
    if (this.compactionPromise) return this.compactionPromise;
    if (this.unsupported) {
      const diagnostic = this.#emitDiagnostic({
        ok: false,
        event: "context-compaction-failed",
        trigger,
        reason: "unsupported",
        recoverable: true,
      });
      return Promise.resolve({ ok: false, reason: "unsupported", diagnostic });
    }
    if (this.activityDepth !== 0 || this.serverStatus !== "idle") {
      const diagnostic = this.#emitDiagnostic({
        ok: false,
        event: "context-compaction-failed",
        trigger,
        reason: "thread-not-idle",
        recoverable: true,
      });
      return Promise.resolve({ ok: false, reason: "thread-not-idle", diagnostic });
    }

    this.lastCompactionStartedAt = this.now();
    this.armed = false;
    const usageBefore = this.latestUsage ? { ...this.latestUsage } : null;
    try {
      this.onOperationStart({ trigger });
    } catch {
      // Phase reporting must never interrupt the compaction request.
    }
    const operation = this.#performCompaction(trigger, usageBefore).finally(() => {
      if (this.compactionPromise === operation) this.compactionPromise = null;
      try {
        this.onOperationEnd({ trigger });
      } catch {
        // Phase reporting must never replace the compaction result.
      }
    });
    this.compactionPromise = operation;
    return operation;
  }

  async #performCompaction(trigger, usageBefore) {
    try {
      await this.#runOfficialCompaction();
      const diagnostic = this.#emitDiagnostic({
        ok: true,
        event: "context-compaction-completed",
        trigger,
        usageBefore: this.#diagnosticUsage(usageBefore),
        usageAfter: this.#diagnosticUsage(this.latestUsage),
      });
      return { ok: true, action: "compacted", diagnostic };
    } catch (error) {
      const reason = error instanceof CodexAppServerCompactionError
        ? error.kind
        : "unexpected-failure";
      if (reason === "unsupported") this.unsupported = true;
      else this.armed = true;
      const diagnostic = this.#emitDiagnostic({
        ok: false,
        event: "context-compaction-failed",
        trigger,
        reason,
        recoverable: true,
        requestCode: Number.isInteger(error?.requestCode) ? error.requestCode : null,
        codexErrorCode: safeProtocolCode(error?.codexErrorCode),
        usageBefore: this.#diagnosticUsage(usageBefore),
      });
      return { ok: false, reason, diagnostic };
    }
  }

  #runOfficialCompaction() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let compactionTurnId = null;
      let compactionItemId = null;
      let itemCompleted = false;
      let terminalCodexErrorCode = null;

      const cleanup = () => {
        clearTimeout(timeout);
        this.codex.off("notification", onNotification);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const fail = (kind, details = {}) => {
        finish(reject, new CodexAppServerCompactionError(kind, details));
      };
      const timeout = setTimeout(() => fail("timeout"), this.timeoutMs);

      const onNotification = (message) => {
        const params = message?.params ?? {};
        if (params.threadId !== this.threadId) return;

        if (
          (message.method === "item/started" || message.method === "item/completed") &&
          params.item?.type === "contextCompaction"
        ) {
          if (compactionTurnId && params.turnId !== compactionTurnId) return;
          if (
            compactionItemId &&
            params.item?.id &&
            params.item.id !== compactionItemId
          ) {
            return;
          }
          compactionTurnId = params.turnId;
          compactionItemId = params.item?.id ?? compactionItemId;
          if (message.method === "item/completed") itemCompleted = true;
          return;
        }

        if (message.method === "error" && params.willRetry === false) {
          if (compactionTurnId && params.turnId !== compactionTurnId) return;
          compactionTurnId = params.turnId;
          terminalCodexErrorCode = extractCodexErrorCode(params.error);
          return;
        }

        if (message.method !== "turn/completed") return;
        const turn = params.turn;
        if (compactionTurnId && turn?.id !== compactionTurnId) return;
        compactionTurnId = turn?.id ?? compactionTurnId;
        if (turn?.status !== "completed") {
          fail("operation-failed", {
            codexErrorCode:
              extractCodexErrorCode(turn?.error) ?? terminalCodexErrorCode,
          });
          return;
        }
        if (!itemCompleted) {
          fail("completion-item-missing");
          return;
        }
        finish(resolve, {
          threadId: this.threadId,
          turnId: compactionTurnId,
          itemId: compactionItemId,
        });
      };

      this.codex.on("notification", onNotification);
      this.codex.request(
        "thread/compact/start",
        { threadId: this.threadId },
        Math.min(this.timeoutMs, COMPACTION_REQUEST_TIMEOUT_MS),
      ).catch((error) => {
        fail(compactionRequestFailureKind(error), {
          requestCode: Number.isInteger(error?.code) ? error.code : null,
        });
      });
    });
  }

  #diagnosticUsage(usage) {
    if (!usage) return null;
    return {
      contextTokens: usage.contextTokens,
      modelContextWindow: usage.modelContextWindow,
      ratio: Math.round(usage.ratio * 10_000) / 10_000,
    };
  }

  #emitDiagnostic(diagnostic) {
    try {
      this.onDiagnostic(diagnostic);
    } catch {
      // Diagnostics must never interrupt the bridge.
    }
    return diagnostic;
  }
}
