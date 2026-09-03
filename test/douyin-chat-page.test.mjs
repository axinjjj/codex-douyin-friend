import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBridgeStartupViewExpression,
  buildClassifyLatestIncomingMediaExpression,
  buildChatMessageMetadataExpression,
  buildChatIdentityMetadataExpression,
  buildCloseOpenSharedWorkExpression,
  buildEnsureChatTailVisibleExpression,
  buildLatestIncomingMediaStructureExpression,
  buildLocateLatestIncomingChatImageExpression,
  buildLocateIncomingMediaReactionTargetExpression,
  buildInspectOpenMediaLikeMenuExpression,
  buildReadLatestIncomingChatImageSourceExpression,
  buildLocateLatestIncomingAwemeExpression,
  buildOpenIncomingSharedWorkExpression,
  buildReadIncomingTextBatchExpression,
  buildReadIncomingCommentShareExpression,
  buildReadIncomingMediaTextExpression,
  buildReadCompatibleAwemeMediaExpression,
  buildReadLatestIncomingTextExpression,
  buildReadOpenSharedWorkStateExpression,
  buildReadOpenSharedWorkVideoExpression,
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
  DOUYIN_SHARED_WORK_VARIANTS,
  isDouyinChatTarget,
  normalizeOutboundText,
  resolveDouyinSharedWorkManifest,
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
  assert.match(expression, /stableContent/u);
  assert.match(expression, /MessageBoxContentactiveClickArea/u);
  assert.doesNotMatch(expression, /slice\(0, 16\)/u);
  assert.doesNotMatch(expression, /document\.cookie|localStorage|sessionStorage/);
  assert.doesNotMatch(expression, /messages\.push\(\{[\s\S]*?\bsource,?\s*\}/);
});

test("chat identity returns only a hash", () => {
  const expression = buildChatIdentityMetadataExpression();
  assert.match(expression, /SHA-256/);
  assert.match(expression, /opponentUserProfile/);
  assert.match(expression, /sec_uid/);
  assert.match(expression, /conversationConversationItemcurConversation/u);
  assert.match(expression, /commonIMAvataravatarContainer/u);
  assert.match(expression, /memoizedProps\?\.secUid/u);
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
  assert.match(openExpression, /BulletBulletVideocontainer/u);
  assert.match(viewerExpression, /querySelectorAll\('video'\)/);
  assert.match(playerExpression, /data-xgplayerid/);
  for (const expression of [openExpression, viewerExpression, playerExpression]) {
    assert.doesNotMatch(expression, /document\.cookie|localStorage|sessionStorage/);
    assert.doesNotMatch(expression, /\.href\b|\.src\b|getAttribute\(['"](?:href|src)/);
  }
});

test("keeps the rendered chat tail current without reading message text", () => {
  const expression = buildEnsureChatTailVisibleExpression();
  assert.match(expression, /scrollTop = scroller\.scrollHeight/u);
  assert.match(expression, /scrollIntoView\(\{ block: 'end'/u);
  assert.match(expression, /atBottom/u);
  assert.doesNotMatch(expression, /textContent|innerText|document\.cookie|localStorage|sessionStorage/u);
});

test("opens one exact shared work and reads only a bounded visible HTTPS video source", () => {
  const exactMessage = {
    ordinalFromEnd: 2,
    fingerprint: "a".repeat(64),
    kind: "media",
    side: "left",
  };
  const open = buildOpenIncomingSharedWorkExpression(exactMessage, "c".repeat(64));
  const read = buildReadOpenSharedWorkVideoExpression();
  const close = buildCloseOpenSharedWorkExpression();
  assert.match(open, /ordinalFromEnd":2/u);
  assert.match(open, /incoming-media-identity-changed/u);
  assert.match(open, /chat-changed-before-shared-work-open/u);
  assert.match(open, /BulletBulletVideoplayIcon/u);
  assert.match(open, /slice\(0, 63\)/u);
  assert.match(open, /__reactProps\$/u);
  assert.match(open, /clickTarget\.click\(\)/u);
  assert.match(read, /commonModalFullScreenModalFullScreen/u);
  assert.match(read, /currentSrc/u);
  assert.match(read, /slice\(0, 4\)/u);
  assert.doesNotThrow(() => new Function(`return ${read}`));
  const state = buildReadOpenSharedWorkStateExpression();
  assert.match(state, /commonModalFullScreenModalFullScreen/u);
  assert.doesNotMatch(state, /currentSrc|getAttribute\('src'\)|textContent|innerText/u);
  assert.doesNotThrow(() => new Function(`return ${state}`));
  assert.match(close, /commonModalFullScreenclose/u);
  assert.match(close, /close\.click\(\)/u);
  for (const expression of [open, read, state, close]) {
    assert.doesNotMatch(expression, /document\.cookie|localStorage|sessionStorage/u);
  }
});

test("direct-image operations classify and capture only visible incoming content", () => {
  const classification = buildClassifyLatestIncomingMediaExpression();
  const locator = buildLocateLatestIncomingChatImageExpression();
  const sourceReader = buildReadLatestIncomingChatImageSourceExpression();
  assert.match(classification, /shared_aweme/u);
  assert.match(classification, /legacy-aweme/u);
  assert.match(classification, /bullet-video/u);
  assert.match(classification, /comment_share/u);
  assert.match(classification, /chat_image/u);
  assert.match(locator, /scrollIntoView/u);
  assert.match(locator, /setTimeout\(resolve, 100\)/u);
  assert.doesNotMatch(locator, /requestAnimationFrame/u);
  assert.match(sourceReader, /currentSrc/u);
  assert.ok(sourceReader.includes("data:image\\/webp;base64"));
  assert.match(sourceReader, /chat-image-webp-requires-screenshot/u);
  assert.doesNotMatch(sourceReader, /OffscreenCanvas|toDataURL|convertToBlob/u);
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

  const exactMessage = {
    ordinalFromEnd: 4,
    fingerprint: "a".repeat(64),
    kind: "media",
    side: "left",
  };
  for (const expression of [
    buildClassifyLatestIncomingMediaExpression(exactMessage),
    buildLocateLatestIncomingChatImageExpression(exactMessage),
    buildReadLatestIncomingChatImageSourceExpression(exactMessage),
  ]) {
    assert.match(expression, /ordinalFromEnd":4/u);
    assert.match(expression, /incoming-media-identity-changed/u);
  }
  assert.throws(
    () => buildClassifyLatestIncomingMediaExpression({ ...exactMessage, side: "right" }),
    /metadata is invalid/u,
  );
});

test("scopes media reactions to one exact incoming message and one bounded menu action", () => {
  const locator = buildLocateIncomingMediaReactionTargetExpression({
    ordinalFromEnd: 1,
    fingerprint: "a".repeat(64),
    kind: "media",
    side: "left",
  });
  const inspect = buildInspectOpenMediaLikeMenuExpression();
  const activate = buildInspectOpenMediaLikeMenuExpression({ activate: true });
  assert.match(locator, /incoming-media-reaction-target-changed/u);
  assert.match(locator, /MessageBoxContentactiveClickArea/u);
  assert.match(locator, /ordinalFromEnd":2/u);
  assert.match(inspect, /MessageOperatePopBodydesc/u);
  assert.match(inspect, /点赞/u);
  assert.doesNotMatch(inspect, /\.click\(\)/u);
  assert.match(activate, /\.click\(\)/u);
  for (const expression of [locator, inspect, activate]) {
    assert.doesNotMatch(expression, /document\.cookie|localStorage|sessionStorage/u);
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
  assert.doesNotMatch(expression, /source:/);
});

test("shared-work inspection distinguishes videos from ordered image posts", () => {
  const expression = buildReadCompatibleAwemeMediaExpression();
  assert.match(expression, /mediaType: "video"/u);
  assert.match(expression, /mediaType: "image_post"/u);
  assert.match(expression, /mediaType: "shared_cover"/u);
  assert.match(expression, /cover_url_v2/u);
  assert.match(expression, /imageList/u);
  assert.match(expression, /MessageItemCommentSharecontainer/u);
  assert.match(expression, /BulletBulletVideocontainer/u);
  assert.match(expression, /item_id/u);
  assert.match(expression, /itemId/u);
  assert.match(expression, /selectedIndexes/u);
  assert.match(expression, /MAX_SELECTED_IMAGES = 12/u);
  assert.match(expression, /attempt < 3/u);
  assert.match(expression, /attempt === 0 \? 250 : 500/u);
  assert.match(expression, /new AbortController\(\)/u);
  assert.match(expression, /controller\.abort\(\), 2000/u);
  assert.match(expression, /bit_rate/u);
  assert.match(expression, /bitRate/u);
  assert.match(expression, /MAX_VIDEO_SOURCES/u);
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

test("registers legacy and bullet shared-work cards without runtime code mutation", () => {
  assert.deepEqual(DOUYIN_SHARED_WORK_VARIANTS, [
    { name: "legacy-aweme", selector: ".MessageItemShareAwemecontainer" },
    { name: "bullet-video", selector: ".BulletBulletVideocontainer" },
  ]);
  const classification = buildClassifyLatestIncomingMediaExpression();
  assert.match(classification, /registeredSharedWorkVariants/u);
  assert.match(classification, /unsupported-media-type/u);
  assert.match(classification, /diagnostic/u);
  assert.match(classification, /SHA-256/u);
  assert.doesNotMatch(classification, /outerHTML|innerHTML|\.href\b|\.src\b|getAttribute\(['"](?:href|src)/u);
});

test("resolves single-image, multi-image, video, and cover-only shared works", () => {
  const single = resolveDouyinSharedWorkManifest({
    parsedContent: {
      item_id: "fixture-item",
      awe_type: 68,
      aweme_info: {
        cover_url: { url_list: ["https://p3.douyinpic.com/single"] },
      },
      im_dynamic_patch: {
        raw_data: JSON.stringify({ whole_card: { extra_info: { log_info: { has_pic: "1" } } } }),
      },
    },
  });
  assert.deepEqual(single, {
    ok: true,
    mediaType: "image_post",
    sources: ["https://p3.douyinpic.com/single"],
    sourceCandidates: [["https://p3.douyinpic.com/single"]],
    totalImageCount: 1,
    sampled: false,
    sourceEvidence: "single-image-react",
  });

  const multiple = resolveDouyinSharedWorkManifest({
    detail: {
      imagePostInfo: {
        imageList: [
          { urlList: ["https://p3.douyinpic.com/first"] },
          { downloadUrlList: ["https://p6.douyinpic.com/second"] },
          { displayImage: { urlList: ["https://p9.douyinpic.com/third"] } },
        ],
      },
    },
  });
  assert.equal(multiple.mediaType, "image_post");
  assert.deepEqual(multiple.sources, [
    "https://p3.douyinpic.com/first",
    "https://p6.douyinpic.com/second",
    "https://p9.douyinpic.com/third",
  ]);
  assert.deepEqual(multiple.sourceCandidates, [
    ["https://p3.douyinpic.com/first"],
    ["https://p6.douyinpic.com/second"],
    ["https://p9.douyinpic.com/third"],
  ]);
  assert.equal(multiple.totalImageCount, 3);

  const video = resolveDouyinSharedWorkManifest({
    detail: {
      videoInfo: {
        playAddrH264: { urlList: ["https://v3.douyinvod.com/video"] },
      },
    },
  });
  assert.equal(video.mediaType, "video");
  assert.equal(video.sources.length, 1);

  const cover = resolveDouyinSharedWorkManifest({
    parsedContent: {
      aweType: 68,
      imageCount: 4,
      coverUrl: { urlList: ["https://p3.douyinpic.com/cover"] },
    },
  });
  assert.deepEqual(cover, {
    ok: true,
    mediaType: "shared_cover",
    sources: ["https://p3.douyinpic.com/cover"],
    sourceCandidates: [["https://p3.douyinpic.com/cover"]],
    totalImageCount: 4,
    sampled: false,
    originalMediaType: "image_post",
  });
});

test("message metadata gives media priority and preserves attached-text identity", () => {
  for (const expression of [buildChatMessageMetadataExpression(), buildBridgeStartupViewExpression()]) {
    assert.match(expression, /hasMedia \? 'media' : (?:textBubble|bubble) \? 'text'/u);
    assert.match(expression, /MessageItemCommentSharecontainer/u);
    assert.match(expression, /messageMessageBoxcontentBox/u);
    assert.match(expression, /shared-work-v2/u);
    assert.match(expression, /item_id/u);
    assert.match(expression, /parsedContent\?\.schema/u);
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
