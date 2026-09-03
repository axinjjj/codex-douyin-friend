import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  CodexAppServerClient,
  extractAgentText,
  instructionSourcesContain,
} from "../src/codex-app-server-client.mjs";
import { summarizeTargets } from "../src/cdp-client.mjs";

test("extractAgentText reads a completed agent message", () => {
  assert.equal(
    extractAgentText({
      type: "agentMessage",
      content: [{ type: "outputText", text: "hello" }, { text: " world" }],
    }),
    "hello world",
  );
});

test("extractAgentText ignores non-agent items", () => {
  assert.equal(extractAgentText({ type: "commandExecution", text: "secret" }), "");
});

test("instructionSourcesContain compares Windows paths safely", () => {
  const expected = path.win32.join("C:\\project", "persona", "AGENTS.md");
  assert.equal(
    instructionSourcesContain(
      [{ path: "c:/project/persona/AGENTS.md" }],
      expected,
    ),
    true,
  );
});

test("starts persistent threads and resumes them with the same safety overrides", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.request = async (method, params) => {
    calls.push({ method, params });
    return {};
  };

  await client.startThread({ cwd: "C:/project", model: "gpt-5.6-sol", ephemeral: false });
  await client.resumeThread({
    threadId: "thread-1",
    cwd: "C:/project",
    model: "gpt-5.6-sol",
  });

  assert.deepEqual(calls[0], {
    method: "thread/start",
    params: {
      cwd: "C:/project",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
      serviceName: "codex_douyin_friend",
      model: "gpt-5.6-sol",
    },
  });
  assert.deepEqual(calls[1], {
    method: "thread/resume",
    params: {
      threadId: "thread-1",
      cwd: "C:/project",
      approvalPolicy: "never",
      sandbox: "read-only",
      model: "gpt-5.6-sol",
    },
  });
});

test("summarizeTargets removes titles, URLs, and debugger addresses", () => {
  assert.deepEqual(
    summarizeTargets([
      {
        type: "page",
        title: "private chat title",
        url: "https://example.invalid/private",
        webSocketDebuggerUrl: "ws://127.0.0.1/private",
      },
    ]),
    [{ type: "page", hasDebuggerEndpoint: true, hasUrl: true }],
  );
});
