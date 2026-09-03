import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBridgeStartupViewExpression,
  buildClassifyLatestIncomingMediaExpression,
  buildChatMessageMetadataExpression,
  buildChatIdentityMetadataExpression,
  buildLatestIncomingMediaStructureExpression,
  buildLocateLatestIncomingChatImageExpression,
  buildReadLatestIncomingChatImageSourceExpression,
  buildLocateLatestIncomingAwemeExpression,
  buildReadIncomingTextBatchExpression,
  buildReadIncomingCommentShareExpression,
  buildReadIncomingMediaTextExpression,
  buildReadCompatibleAwemeMediaExpression,
  buildReadLatestIncomingTextExpression,
  buildReadXgPlayerSourceExpression,
  buildReadCompatibleAwemeSourceExpression,
  buildRecentDouyinResourcePathsExpression,
  buildAwemeReactDataShapeExpression,
  buildProbeAwemeDetailVariantsExpression,
  buildReadRecentConversationExpression,
  buildChatStructureExpression,
  buildVisibleVideoStructureExpression,
  buildXgPlayerStructureExpression,
  DOUYIN_CHAT_INPUT_SELECTOR,
  isDouyinChatTarget,
  normalizeOutboundText,
} from "../src/douyin-chat-page.mjs";

test("recognizes only a debuggable Douyin chat page", () => {
  assert.equal(
    isDouyinChatTarget({
      type: "page",
      url: "https://www.douyin.com/chat",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/example",
    }),
    true,
  );
  assert.equal(
    isDouyinChatTarget({
      type: "page",
      url: "https://example.invalid/chat",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/example",
    }),
    false,
  );
  assert.equal(
    isDouyinChatTarget({ type: "iframe", url: "https://www.douyin.com/chat" }),
    false,
  );
});

test("message metadata hashes content without returning it", () => {
  const expression = buildChatMessageMetadataExpression();
  assert.match(expression, /SHA-256/);
  assert.match(expression, /chatFingerprint/u);
  assert.match(expression, /const captured =/u);
  assert.match(expression, /fingerprint/);
  assert.doesNotMatch(expression, /slice\(0, 16\)/u);
  assert.doesNotMatch(expression, /document\.cookie|localStorage|sessionStorage/);
  assert.doesNotMatch(expression, /messages\.push\(\{[\s\S]*?\bsource,?\s*\}/);
});

test("chat identity returns only a hash", () => {
  const expression = buildChatIdentityMetadataExpression();
  assert.match(expression, /SHA-256/);
  assert.match(expression, /opponentUserProfile/);
  assert.match(expression, /sec_uid/);
  assert.doesNotMatch(expression, /slice\(0, 16\)/u);
  assert.doesNotMatch(expression, /return \{ found: true, (title|value)/);
  assert.doesNotMatch(expression, /document\.cookie|localStorage|sessionStorage/u);
  assert.doesNotMatch(expression, /title\?\.textContent/u);
});

test("startup view captures one bounded snapshot and seeding conversation", () => {
  const expression = buildBridgeStartupViewExpression();
  assert.match(expression, /const captured =/u);
  assert.match(expression, /snapshot:/u);
  assert.match(expression, /conversation/u);
  assert.match(expression, /chatFingerprint/u);
  assert.match(expression, /SHA-256/u);
  assert.doesNotMatch(expression, /document\.cookie|localStorage|sessionStorage/u);
});

test("reads an exact bounded incoming text batch by full fingerprints", () => {
  const expression = buildReadIncomingTextBatchExpression([
    { fingerprint: "a".repeat(64), kind: "text", side: "left", ordinalFromEnd: 2 },
    { fingerprint: "b".repeat(64), kind: "text", side: "left", ordinalFromEnd: 1 },
  ]);
  assert.match(expression, /incoming-text-fingerprint-changed/u);
  assert.match(expression, /SHA-256/u);
  assert.match(expression, /chatFingerprint/u);
  assert.match(expression, /const captured =/u);
  assert.doesNotMatch(expression, /document\.cookie|localStorage|sessionStorage/u);
  assert.throws(() => buildReadIncomingTextBatchExpression([]));
  assert.throws(() => buildReadIncomingTextBatchExpression([
    { fingerprint: "short", kind: "text", side: "left", ordinalFromEnd: 1 },
  ]));
});

test("structure inspection never requests private text or attribute values", () => {
  const expressions = [
    buildChatStructureExpression(),
    buildLatestIncomingMediaStructureExpression(),
  ];
  assert.match(expressions[0], /data-slate-editor/);
  assert.equal(DOUYIN_CHAT_INPUT_SELECTOR.includes("contenteditable"), true);
  for (const expression of expressions) {
    assert.doesNotMatch(expression, /textContent|innerText|\.value\b|outerHTML|innerHTML/);
    assert.doesNotMatch(expression, /document\.cookie|localStorage|sessionStorage/);
    assert.doesNotMatch(expression, /\.href\b|\.src\b|getAttribute\(['"](?:href|src)/);
  }
});

test("normalizes and bounds outbound text", () => {
  assert.equal(normalizeOutboundText("  hello\n\nworld  "), "hello world");
  assert.equal(normalizeOutboundText("abcdef", 3), "abc");
});

test("sensitive read and insert expressions do not access account storage", () => {
  const expressions = [
    buildReadLatestIncomingTextExpression(),
    buildReadRecentConversationExpression(),
    buildReadXgPlayerSourceExpression(),
    buildReadCompatibleAwemeSourceExpression(),
  ];
  for (const expression of expressions) {
    assert.doesNotMatch(expression, /document\.cookie|localStorage|sessionStorage/);
  }
});

test("chat expressions order messages by their visual vertical position", () => {
  assert.match(buildChatMessageMetadataExpression(), /getBoundingClientRect\(\)\.top/);
  assert.match(buildReadLatestIncomingTextExpression(), /right\.getBoundingClientRect\(\)\.top/);
  assert.match(buildReadRecentConversationExpression(), /left\.getBoundingClientRect\(\)\.top/);
});

test("video-card operations stay scoped to the visible page DOM", () => {
  const openExpression = buildLocateLatestIncomingAwemeExpression();
  const viewerExpression = buildVisibleVideoStructureExpression();
  const playerExpression = buildXgPlayerStructureExpression();
  assert.match(openExpression, /MessageItemShareAwemecontainer/);
  assert.match(viewerExpression, /querySelectorAll\('video'\)/);
  assert.match(playerExpression, /data-xgplayerid/);
  for (const expression of [openExpression, viewerExpression, playerExpression]) {
    assert.doesNotMatch(expression, /document\.cookie|localStorage|sessionStorage/);
    assert.doesNotMatch(expression, /\.href\b|\.src\b|getAttribute\(['"](?:href|src)/);
  }
});

test("direct-image operations classify and capture only visible incoming content", () => {
  const classification = buildClassifyLatestIncomingMediaExpression();
  const locator = buildLocateLatestIncomingChatImageExpression();
  const sourceReader = buildReadLatestIncomingChatImageSourceExpression();
  assert.match(classification, /shared_aweme/u);
  assert.match(classification, /comment_share/u);
  assert.match(classification, /chat_image/u);
  assert.match(locator, /scrollIntoView/u);
  assert.match(locator, /setTimeout\(resolve, 100\)/u);
  assert.doesNotMatch(locator, /requestAnimationFrame/u);
  assert.match(sourceReader, /currentSrc/u);
  assert.doesNotMatch(sourceReader, /document\.cookie|localStorage|sessionStorage/u);
  assert.match(locator, /clip/u);
  for (const expression of [classification, locator]) {
    assert.match(expression, /messageMessageBoxisFromMe/u);
    assert.match(expression, /side !== 'left'/u);
    assert.doesNotMatch(expression, /relativeCenter/u);
    assert.doesNotMatch(expression, /document\.cookie|localStorage|sessionStorage/u);
    assert.doesNotMatch(expression, /textContent|innerText|outerHTML|innerHTML/u);
    assert.doesNotMatch(expression, /\.src\b|getAttribute\(['"]src/u);
  }
});

test("resource inspection returns only trusted generic paths", () => {
  const expression = buildRecentDouyinResourcePathsExpression();
  assert.match(expression, /url\.pathname/);
  assert.doesNotMatch(expression, /url\.search|searchParams|document\.cookie|localStorage|sessionStorage/);
});

test("React card inspection returns schema shape rather than values", () => {
  const expression = buildAwemeReactDataShapeExpression();
  assert.match(expression, /__reactFiber\$/);
  assert.match(expression, /stringLength/);
  assert.doesNotMatch(expression, /textContent|innerText|document\.cookie|localStorage|sessionStorage/);
});

test("Aweme variant probe keeps response URLs and ids out of its result", () => {
  const expression = buildProbeAwemeDetailVariantsExpression();
  assert.match(expression, /aweme\/detail/);
  assert.match(expression, /codecType/);
  assert.doesNotMatch(expression, /document\.cookie|localStorage|sessionStorage/);
  assert.doesNotMatch(expression, /return \{[^}]*itemId/);
  assert.doesNotMatch(expression, /urlList|source:/);
});

test("shared-work inspection distinguishes videos from ordered image posts", () => {
  const expression = buildReadCompatibleAwemeMediaExpression();
  assert.match(expression, /mediaType: 'video'/u);
  assert.match(expression, /mediaType: 'image_post'/u);
  assert.match(expression, /mediaType: 'shared_cover'/u);
  assert.match(expression, /cover_url_v2/u);
  assert.match(expression, /image_post_info/u);
  assert.match(expression, /MessageItemCommentSharecontainer/u);
  assert.match(expression, /selectedIndexes/u);
  assert.match(expression, /maxImages = 12/u);
  assert.doesNotMatch(expression, /document\.cookie|localStorage|sessionStorage/u);
  assert.doesNotMatch(expression, /return \{[^}]*itemId/u);

  const exactExpression = buildReadCompatibleAwemeMediaExpression({
    ordinalFromEnd: 1,
    fingerprint: "a".repeat(64),
    kind: "media",
    side: "left",
  });
  assert.match(exactExpression, /incoming-shared-work-identity-changed/u);
  assert.match(exactExpression, /messageMessageBoxcontentBox/u);
});

test("message metadata gives media priority and preserves attached-text identity", () => {
  for (const expression of [buildChatMessageMetadataExpression(), buildBridgeStartupViewExpression()]) {
    assert.match(expression, /hasMedia \? 'media' : (?:textBubble|bubble) \? 'text'/u);
    assert.match(expression, /MessageItemCommentSharecontainer/u);
    assert.match(expression, /messageMessageBoxcontentBox/u);
  }
  const expression = buildReadIncomingMediaTextExpression({
    ordinalFromEnd: 1,
    fingerprint: "a".repeat(64),
    kind: "media",
    side: "left",
  });
  assert.match(expression, /incoming-media-fingerprint-changed/u);
  assert.match(expression, /bubble\?\.textContent/u);
  assert.doesNotMatch(expression, /document\.cookie|localStorage|sessionStorage/u);
});

test("reads an exact comment share without exposing comment or account identifiers", () => {
  const expression = buildReadIncomingCommentShareExpression({
    ordinalFromEnd: 1,
    fingerprint: "a".repeat(64),
    kind: "media",
    side: "left",
  });
  assert.match(expression, /MessageItemCommentSharecommentText/u);
  assert.match(expression, /MessageItemCommentSharetitleName/u);
  assert.match(expression, /MessageItemCommentShareawemeTitle/u);
  assert.match(expression, /incoming-comment-share-identity-changed/u);
  assert.match(expression, /messageMessageBoxcontentBox/u);
  assert.doesNotMatch(expression, /comment_id|comment_secuid|itemId/u);
  assert.doesNotMatch(expression, /document\.cookie|localStorage|sessionStorage/u);
});
