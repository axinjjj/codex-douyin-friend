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

const focusEmptyEditorExpression = `(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none'
      && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };
  const editors = Array.from(document.querySelectorAll(
    ${JSON.stringify(DOUYIN_CHAT_INPUT_SELECTOR)}
  )).filter(visible);
  if (editors.length !== 1) return { ok: false, reason: 'visible-editor-count' };
  const editor = editors[0];
  const actual = (editor.textContent || '').replace(/[\u200B\uFEFF]/gu, '').trim();
  if (actual) return { ok: false, reason: 'chat-input-not-empty' };
  editor.focus();
  editor.click();
  return document.activeElement === editor
    ? { ok: true }
    : { ok: false, reason: 'chat-input-focus-failed' };
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

  const focused = await client.evaluate(focusEmptyEditorExpression);
  if (!focused?.ok) return focused;
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
  quoteBinding = null,
}) {
  const outboundText = normalizeOutboundText(expectedText);
  if (!outboundText) throw new Error("Expected Douyin editor text is empty.");
  return client.evaluate(buildVerifyChatEditorReadyExpression({
    expectedText: outboundText,
    expectedChatFingerprint,
    quoteBinding,
  }));
}
