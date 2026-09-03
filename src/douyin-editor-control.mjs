import {
  DOUYIN_CHAT_INPUT_SELECTOR,
  buildVerifyChatEditorReadyExpression,
  normalizeOutboundText,
} from "./douyin-chat-page.mjs";

const focusEditorExpression = `(() => {
  const editor = document.querySelector(${JSON.stringify(DOUYIN_CHAT_INPUT_SELECTOR)});
  if (!editor) return { ok: false };
  editor.focus();
  editor.click();
  return { ok: document.activeElement === editor };
})()`;

export async function focusAndClearChatEditor(client) {
  const focused = await client.evaluate(focusEditorExpression);
  if (!focused?.ok) throw new Error("Douyin chat editor could not be focused.");

  await client.request("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "a",
    code: "KeyA",
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  });
  await client.request("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  });
  await client.request("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
  await client.request("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
}

export async function replaceChatEditorText(client, text) {
  const outboundText = normalizeOutboundText(text);
  if (!outboundText) throw new Error("Refusing to insert an empty Douyin message.");

  await focusAndClearChatEditor(client);
  await client.request("Input.insertText", { text: outboundText });

  const result = await client.evaluate(`(() => {
    const editor = document.querySelector(${JSON.stringify(DOUYIN_CHAT_INPUT_SELECTOR)});
    if (!editor) return { ok: false, reason: 'chat-input-not-found' };
    const expected = ${JSON.stringify(outboundText)};
    const actual = (editor.textContent || '').replace(/[\u200B\uFEFF]/gu, '').trim();
    return {
      ok: actual === expected,
      actualLength: actual.length,
      expectedLength: expected.length,
    };
  })()`);

  return result;
}

export async function verifyChatEditorReady(client, {
  expectedText,
  expectedChatFingerprint,
}) {
  const outboundText = normalizeOutboundText(expectedText);
  if (!outboundText) throw new Error("Expected Douyin editor text is empty.");
  return client.evaluate(buildVerifyChatEditorReadyExpression({
    expectedText: outboundText,
    expectedChatFingerprint,
  }));
}
