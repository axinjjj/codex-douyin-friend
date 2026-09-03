export const DOUYIN_CHAT_INPUT_SELECTOR =
  'div[data-slate-editor="true"][contenteditable="true"]';
export const DOUYIN_CHAT_LIST_SELECTOR = ".messageMessageListlist";
export const DOUYIN_MESSAGE_SELECTOR = ".messageMessageBoxmessageBox";
export const DOUYIN_TEXT_BUBBLE_SELECTOR = ".MessageItemTextbubbleTextContent";

const STRUCTURE_HINT =
  /(chat|message|conversation|right|panel|scroll|content|item|list|editor|input|bubble|card|video|streak)/i;

const CHAT_IDENTITY_CAPTURE_SOURCE = `
    const title = document.querySelector('.RightPanelHeadertitle');
    let opaqueId = null;
    let identityElement = title;
    for (let elementDepth = 0; identityElement && elementDepth < 6 && !opaqueId; elementDepth += 1) {
      const fiberKey = Object.keys(identityElement)
        .find((key) => key.startsWith('__reactFiber$'));
      let fiber = fiberKey ? identityElement[fiberKey] : null;
      for (let fiberDepth = 0; fiber && fiberDepth < 20 && !opaqueId; fiberDepth += 1) {
        const profile = fiber.memoizedProps?.opponentUserProfile;
        const candidate = profile?.sec_uid || profile?.secUid || profile?.uid;
        if (typeof candidate === 'string' && candidate.trim().length >= 8) {
          opaqueId = candidate.trim();
        }
        fiber = fiber.return;
      }
      identityElement = identityElement.parentElement;
    }
`;

const MESSAGE_SIDE_CAPTURE_SOURCE = `
    const centered = message.classList.contains('messageMessageBoxisFullRowCenterMessage');
    const fromMe = Boolean(message.querySelector(
      '.messageMessageBoxisFromMe, .MessageBoxContentisFromMe, .MessageItemTextisFromMe'
    ));
    const side = centered ? 'center' : fromMe ? 'right' : 'left';
`;

export function buildChatStructureExpression() {
  return `(() => {
    const inputSelector = ${JSON.stringify(DOUYIN_CHAT_INPUT_SELECTOR)};
    const structureHint = ${STRUCTURE_HINT};
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const classHints = (element) => Array.from(element.classList || [])
      .filter((token) => structureHint.test(token) && /^[A-Za-z0-9_-]{1,100}$/.test(token))
      .slice(0, 8);
    const describe = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || null,
        editable: element.getAttribute('contenteditable') === 'true',
        classHints: classHints(element),
        attributeNames: Array.from(element.attributes || [])
          .map((attribute) => attribute.name)
          .filter((name) => !name.startsWith('data-e2e-') && name !== 'id')
          .slice(0, 12),
        childCount: element.children.length,
        descendantCount: element.querySelectorAll('*').length,
        imageCount: element.querySelectorAll('img, video').length,
        editableCount: element.querySelectorAll(inputSelector).length,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        overflowY: style.overflowY,
        scrollable: element.scrollHeight > element.clientHeight + 10,
      };
    };

    const editor = document.querySelector(inputSelector);
    const editorAncestors = [];
    let current = editor;
    for (let depth = 0; current && depth < 9; depth += 1, current = current.parentElement) {
      editorAncestors.push({ depth, ...describe(current) });
    }

    const hintedElements = Array.from(document.querySelectorAll('div, main, section, article, [role]'))
      .filter((element) => visible(element) && classHints(element).length > 0)
      .slice(0, 100)
      .map((element) => ({
        ...describe(element),
        parentClassHints: element.parentElement ? classHints(element.parentElement) : [],
      }));

    const structuralCandidates = Array.from(document.querySelectorAll('main, section, [role], div'))
      .filter((element) => visible(element))
      .map((element) => ({
        element,
        description: describe(element),
        hinted: classHints(element).length > 0,
      }))
      .filter(({ description, hinted }) =>
        description.scrollable ||
        (hinted && description.childCount >= 2 && description.height >= 80)
      )
      .sort((left, right) => {
        const score = (candidate) =>
          Number(candidate.description.scrollable) * 1000000 +
          candidate.description.descendantCount * 1000 +
          candidate.description.height;
        return score(right) - score(left);
      })
      .slice(0, 20)
      .map(({ description }) => description);

    return {
      isHttpsChatPage: location.protocol === 'https:' && location.pathname.startsWith('/chat'),
      readyState: document.readyState,
      inputMatchCount: document.querySelectorAll(inputSelector).length,
      editorAncestors,
      hintedElements,
      structuralCandidates,
    };
  })()`;
}

export function buildChatMessageMetadataExpression() {
  return `(async () => {
    ${CHAT_IDENTITY_CAPTURE_SOURCE}
    const listSelector = ${JSON.stringify(DOUYIN_CHAT_LIST_SELECTOR)};
    const messageSelector = ${JSON.stringify(DOUYIN_MESSAGE_SELECTOR)};
    const textBubbleSelector = ${JSON.stringify(DOUYIN_TEXT_BUBBLE_SELECTOR)};
    const digest = async (value) => {
      const bytes = new TextEncoder().encode(value);
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    };

    const list = document.querySelector(listSelector);
    if (!list) {
      return { listFound: false, messageCount: 0, messages: [] };
    }

    const allMessages = Array.from(list.querySelectorAll(messageSelector))
      .sort((left, right) =>
        left.getBoundingClientRect().top - right.getBoundingClientRect().top
      );
    const captured = allMessages.slice(-12).map((message) => {
      const textBubble = message.querySelector(textBubbleSelector);
      ${MESSAGE_SIDE_CAPTURE_SOURCE}
      const source = (textBubble?.textContent || message.textContent || '').trim();
      const hasMedia = Boolean(message.querySelector(
        '.MessageItemShareAwemecontainer, .MessageItemImageImageBox, video, canvas, [class*="Video"], [class*="Aweme"], [class*="Card"]'
      ));
      const kind = hasMedia ? 'media' : textBubble ? 'text' : centered ? 'system' : 'unknown';
      const structuralKey = kind === 'media' || kind === 'text'
        ? [kind, side, source].join('|')
        : [kind, side, source, message.querySelectorAll('img').length, message.querySelectorAll('video').length].join('|');
      return { kind, side, textLength: source.length, structuralKey };
    });
    const messages = [];
    for (let index = 0; index < captured.length; index += 1) {
      const message = captured[index];
      messages.push({
        ordinalFromEnd: captured.length - index,
        kind: message.kind,
        side: message.side,
        textLength: message.textLength,
        fingerprint: await digest(message.structuralKey),
      });
    }

    return {
      listFound: true,
      chatFingerprint: opaqueId ? await digest(['douyin-opponent-v1', opaqueId].join('|')) : null,
      messageCount: allMessages.length,
      messages,
    };
  })()`;
}

export function buildBridgeStartupViewExpression(limit = 12) {
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 12, 30));
  return `(async () => {
    ${CHAT_IDENTITY_CAPTURE_SOURCE}
    const list = document.querySelector(${JSON.stringify(DOUYIN_CHAT_LIST_SELECTOR)});
    if (!list) return {
      ok: false,
      snapshot: { messageCount: 0, messages: [] },
      conversation: [],
    };
    const digest = async (value) => {
      const bytes = new TextEncoder().encode(value);
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
    };
    const captured = Array.from(list.querySelectorAll(${JSON.stringify(DOUYIN_MESSAGE_SELECTOR)}))
      .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)
      .map((message) => {
        const bubble = message.querySelector(${JSON.stringify(DOUYIN_TEXT_BUBBLE_SELECTOR)});
        ${MESSAGE_SIDE_CAPTURE_SOURCE}
        const source = (bubble?.textContent || message.textContent || '').trim();
        const hasMedia = Boolean(message.querySelector(
          '.MessageItemShareAwemecontainer, .MessageItemImageImageBox, video, canvas, [class*="Video"], [class*="Aweme"], [class*="Card"]'
        ));
        const kind = hasMedia ? 'media' : bubble ? 'text' : centered ? 'system' : 'unknown';
        const structuralKey = kind === 'media' || kind === 'text'
          ? [kind, side, source].join('|')
          : [kind, side, source, message.querySelectorAll('img').length, message.querySelectorAll('video').length].join('|');
        return {
          source,
          side,
          kind,
          structuralKey,
          role: side === 'left' ? 'user' : side === 'right' ? 'assistant' : null,
        };
      });

    const recent = captured.slice(-12);
    const messages = [];
    for (let index = 0; index < recent.length; index += 1) {
      const message = recent[index];
      messages.push({
        ordinalFromEnd: recent.length - index,
        kind: message.kind,
        side: message.side,
        fingerprint: await digest(message.structuralKey),
      });
    }
    const conversation = [];
    const conversationSource = captured
      .filter((message) => message.kind === 'text' && message.role && message.source)
      .slice(-${safeLimit});
    for (const message of conversationSource) {
      conversation.push({
        role: message.role,
        text: message.source,
        fingerprint: await digest(['text', message.side, message.source].join('|')),
      });
    }
    return {
      ok: true,
      chatFingerprint: opaqueId ? await digest(['douyin-opponent-v1', opaqueId].join('|')) : null,
      snapshot: { messageCount: captured.length, messages },
      conversation,
    };
  })()`;
}

export function buildLatestIncomingMediaStructureExpression() {
  return `(async () => {
    const list = document.querySelector(${JSON.stringify(DOUYIN_CHAT_LIST_SELECTOR)});
    if (!list) return { ok: false, reason: 'message-list-not-found' };

    const structureHint = ${STRUCTURE_HINT};
    const classHints = (element) => Array.from(element?.classList || [])
      .filter((token) => structureHint.test(token) && /^[A-Za-z0-9_-]{1,100}$/.test(token))
      .slice(0, 8);
    const digest = async (value) => {
      const bytes = new TextEncoder().encode(value);
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    };
    const messages = Array.from(list.querySelectorAll(${JSON.stringify(DOUYIN_MESSAGE_SELECTOR)}))
      .sort((left, right) =>
        right.getBoundingClientRect().top - left.getBoundingClientRect().top
      );

    for (const message of messages) {
      ${MESSAGE_SIDE_CAPTURE_SOURCE}
      if (side !== 'left') continue;
      const hasMedia = Boolean(message.querySelector(
        '.MessageItemShareAwemecontainer, .MessageItemImageImageBox, video, canvas, [class*="Video"], [class*="Aweme"], [class*="Card"]'
      ));
      if (!hasMedia) continue;
      const descendants = Array.from(message.querySelectorAll('*'));
      const hinted = [message, ...descendants]
        .filter((element) => classHints(element).length > 0)
        .slice(0, 24)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          classHints: classHints(element),
          attributeNames: Array.from(element.attributes || [])
            .map((attribute) => attribute.name)
            .filter((name) => !name.startsWith('data-e2e-') && name !== 'id')
            .slice(0, 12),
        }));
      const structuralKey = [
        descendants.length,
        message.querySelectorAll('a').length,
        message.querySelectorAll('img').length,
        message.querySelectorAll('video').length,
        message.querySelectorAll('button, [role="button"]').length,
        JSON.stringify(hinted),
      ].join('|');

      return {
        ok: true,
        message: {
          fingerprint: await digest(structuralKey),
          descendantCount: descendants.length,
          linkCount: message.querySelectorAll('a').length,
          imageCount: message.querySelectorAll('img').length,
          videoCount: message.querySelectorAll('video').length,
          buttonCount: message.querySelectorAll('button, [role="button"]').length,
          canvasCount: message.querySelectorAll('canvas').length,
          hinted,
        },
      };
    }

    return { ok: false, reason: 'incoming-media-not-found' };
  })()`;
}

export function buildClassifyLatestIncomingMediaExpression() {
  return `(() => {
    const list = document.querySelector(${JSON.stringify(DOUYIN_CHAT_LIST_SELECTOR)});
    if (!list) return { ok: false, reason: 'message-list-not-found' };
    const messages = Array.from(list.querySelectorAll(${JSON.stringify(DOUYIN_MESSAGE_SELECTOR)}))
      .sort((left, right) => right.getBoundingClientRect().top - left.getBoundingClientRect().top);
    for (const message of messages) {
      ${MESSAGE_SIDE_CAPTURE_SOURCE}
      if (side !== 'left') continue;
      const content = message.querySelector('.MessageBoxContentactiveClickArea') ||
        message.querySelector('.messageMessageBoxcontentBox');
      if (!content) continue;
      if (message.querySelector('.MessageItemShareAwemecontainer')) {
        return { ok: true, mediaType: 'shared_aweme' };
      }
      const visibleImage = Array.from(message.querySelectorAll('.MessageItemImageImage, .MessageItemImageImageBox img'))
        .find((image) => {
          const imageRect = image.getBoundingClientRect();
          const style = getComputedStyle(image);
          return imageRect.width >= 32 && imageRect.height >= 32 &&
            style.display !== 'none' && style.visibility !== 'hidden';
        });
      if (visibleImage) return { ok: true, mediaType: 'chat_image' };
      if (message.querySelector(${JSON.stringify(DOUYIN_TEXT_BUBBLE_SELECTOR)})) continue;
      return { ok: false, reason: 'unsupported-media-type' };
    }
    return { ok: false, reason: 'incoming-media-not-found' };
  })()`;
}

export function buildLocateLatestIncomingChatImageExpression() {
  return `(async () => {
    const list = document.querySelector(${JSON.stringify(DOUYIN_CHAT_LIST_SELECTOR)});
    if (!list) return { ok: false, reason: 'message-list-not-found' };
    const messages = Array.from(list.querySelectorAll(${JSON.stringify(DOUYIN_MESSAGE_SELECTOR)}))
      .sort((left, right) => right.getBoundingClientRect().top - left.getBoundingClientRect().top);
    for (const message of messages) {
      ${MESSAGE_SIDE_CAPTURE_SOURCE}
      if (side !== 'left') continue;
      const content = message.querySelector('.MessageBoxContentactiveClickArea') ||
        message.querySelector('.messageMessageBoxcontentBox');
      if (!content) continue;
      if (message.querySelector('.MessageItemShareAwemecontainer')) {
        return { ok: false, reason: 'latest-media-is-shared-aweme' };
      }
      const image = Array.from(message.querySelectorAll('.MessageItemImageImage, .MessageItemImageImageBox img'))
        .find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          const style = getComputedStyle(candidate);
          return rect.width >= 32 && rect.height >= 32 &&
            style.display !== 'none' && style.visibility !== 'hidden';
        });
      if (!image) {
        if (message.querySelector(${JSON.stringify(DOUYIN_TEXT_BUBBLE_SELECTOR)})) continue;
        return { ok: false, reason: 'chat-image-not-found' };
      }
      image.scrollIntoView({ block: 'center', inline: 'center' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const rect = image.getBoundingClientRect();
      const x = Math.max(0, rect.left + window.scrollX);
      const y = Math.max(0, rect.top + window.scrollY);
      const width = Math.min(rect.width, window.innerWidth - Math.max(0, rect.left));
      const height = Math.min(rect.height, window.innerHeight - Math.max(0, rect.top));
      if (width < 16 || height < 16 || width > 2048 || height > 2048) {
        return { ok: false, reason: 'chat-image-clip-invalid' };
      }
      return {
        ok: true,
        clip: {
          x: Math.round(x * 100) / 100,
          y: Math.round(y * 100) / 100,
          width: Math.round(width * 100) / 100,
          height: Math.round(height * 100) / 100,
          scale: 1,
        },
      };
    }
    return { ok: false, reason: 'incoming-media-not-found' };
  })()`;
}

export function buildReadLatestIncomingChatImageSourceExpression() {
  return `(() => {
    const list = document.querySelector(${JSON.stringify(DOUYIN_CHAT_LIST_SELECTOR)});
    if (!list) return { ok: false, reason: 'message-list-not-found' };
    const messages = Array.from(list.querySelectorAll(${JSON.stringify(DOUYIN_MESSAGE_SELECTOR)}))
      .sort((left, right) => right.getBoundingClientRect().top - left.getBoundingClientRect().top);
    for (const message of messages) {
      ${MESSAGE_SIDE_CAPTURE_SOURCE}
      if (side !== 'left') continue;
      const content = message.querySelector('.MessageBoxContentactiveClickArea') ||
        message.querySelector('.messageMessageBoxcontentBox');
      if (!content) continue;
      if (message.querySelector('.MessageItemShareAwemecontainer')) continue;
      const image = Array.from(message.querySelectorAll('.MessageItemImageImage, .MessageItemImageImageBox img'))
        .find((candidate) => {
          const imageRect = candidate.getBoundingClientRect();
          const style = getComputedStyle(candidate);
          return imageRect.width >= 32 && imageRect.height >= 32 &&
            style.display !== 'none' && style.visibility !== 'hidden';
        });
      if (!image) continue;
      const source = image.currentSrc || image.src || '';
      if (!source) return { ok: false, reason: 'chat-image-source-not-found' };
      return { ok: true, source };
    }
    return { ok: false, reason: 'incoming-chat-image-not-found' };
  })()`;
}

export function buildLocateLatestIncomingAwemeExpression() {
  return `(() => {
    const list = document.querySelector(${JSON.stringify(DOUYIN_CHAT_LIST_SELECTOR)});
    if (!list) return { ok: false, reason: 'message-list-not-found' };
    const messages = Array.from(list.querySelectorAll(${JSON.stringify(DOUYIN_MESSAGE_SELECTOR)}))
      .sort((left, right) =>
        right.getBoundingClientRect().top - left.getBoundingClientRect().top
      );

    for (const message of messages) {
      ${MESSAGE_SIDE_CAPTURE_SOURCE}
      if (side !== 'left') continue;
      const card = message.querySelector('.MessageItemShareAwemecontainer');
      if (!card) continue;
      const clickTarget = message.querySelector('.MessageBoxContentactiveClickArea') || card;
      clickTarget.scrollIntoView({ block: 'center', inline: 'center' });
      const centeredRect = clickTarget.getBoundingClientRect();
      return {
        ok: true,
        x: Math.round(centeredRect.left + centeredRect.width / 2),
        y: Math.round(centeredRect.top + centeredRect.height / 2),
      };
    }

    return { ok: false, reason: 'incoming-aweme-card-not-found' };
  })()`;
}

export function buildVisibleVideoStructureExpression() {
  return `(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
        style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
    };
    const videos = Array.from(document.querySelectorAll('video'))
      .filter(visible)
      .map((video) => {
        const rect = video.getBoundingClientRect();
        return {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          readyState: video.readyState,
          durationKnown: Number.isFinite(video.duration) && video.duration > 0,
          paused: video.paused,
          muted: video.muted,
        };
      });
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="dialog" i]'))
      .filter(visible);
    return {
      isChatPath: location.protocol === 'https:' && location.pathname.startsWith('/chat'),
      visibleVideoCount: videos.length,
      videos,
      visibleDialogCount: dialogs.length,
    };
  })()`;
}

export function buildXgPlayerStructureExpression() {
  return `(() => {
    const root = document.querySelector('[data-xgplayerid]');
    if (!root) return { ok: false, reason: 'xgplayer-not-found' };
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
        style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
    };
    const descendants = Array.from(root.querySelectorAll('*'));
    const tagCounts = {};
    for (const element of descendants) {
      const tag = element.tagName.toLowerCase();
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
    const visibleElements = descendants
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          classNames: Array.from(element.classList || [])
            .filter((token) => /^[A-Za-z0-9_-]{1,100}$/.test(token))
            .slice(0, 10),
          attributeNames: Array.from(element.attributes || [])
            .map((attribute) => attribute.name)
            .filter((name) => !name.startsWith('data-e2e-') && name !== 'id')
            .slice(0, 12),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter((element) => element.width >= 80 && element.height >= 40)
      .slice(0, 40);
    const video = root.querySelector('video');
    const videoRect = video?.getBoundingClientRect();
    return {
      ok: true,
      descendantCount: descendants.length,
      tagCounts,
      visibleElements,
      hasOpenShadowRoot: Boolean(root.shadowRoot),
      video: video ? {
        readyState: video.readyState,
        networkState: video.networkState,
        errorCode: video.error?.code || null,
        paused: video.paused,
        ended: video.ended,
        currentTime: Math.round(video.currentTime * 10) / 10,
        duration: Number.isFinite(video.duration) ? Math.round(video.duration * 10) / 10 : null,
        width: Math.round(videoRect.width),
        height: Math.round(videoRect.height),
        hasCurrentSrc: Boolean(video.currentSrc),
        hasSrcAttribute: video.hasAttribute('src'),
      } : null,
    };
  })()`;
}

export function buildReadXgPlayerSourceExpression() {
  return `(() => {
    const video = document.querySelector('[data-xgplayerid] video');
    const source = video?.currentSrc || video?.getAttribute('src') || '';
    if (!source) return { ok: false, reason: 'video-source-not-found' };
    return { ok: true, source };
  })()`;
}

export function buildRecentDouyinResourcePathsExpression() {
  return `(() => ({
    paths: [...new Set(performance.getEntriesByType('resource')
      .map((entry) => {
        try {
          const url = new URL(entry.name);
          const trusted = url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com') ||
            url.hostname === 'douyinvod.com' || url.hostname.endsWith('.douyinvod.com');
          return trusted && /(aweme|video|feed|detail|play)/i.test(url.pathname)
            ? url.pathname
            : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean))].slice(-30),
  }))()`;
}

export function buildAwemeReactDataShapeExpression() {
  return `(() => {
    const card = document.querySelector('.MessageItemShareAwemecontainer');
    if (!card) return { ok: false, reason: 'aweme-card-not-found' };
    const fiberKey = Object.keys(card).find((key) => key.startsWith('__reactFiber$'));
    if (!fiberKey) return { ok: false, reason: 'react-fiber-not-found' };
    const interesting = /(aweme|video|play|url|src|cover|message|content|item|media|codec|h26|bitrate)/i;
    const seen = new WeakSet();
    const matches = [];
    let visited = 0;
    const walk = (value, path, depth) => {
      if (visited >= 1500 || depth > 7 || value === null || value === undefined) return;
      const type = typeof value;
      if (type !== 'object') return;
      if (seen.has(value)) return;
      seen.add(value);
      visited += 1;
      for (const key of Object.keys(value).slice(0, 80)) {
        const child = value[key];
        const childPath = path ? path + '.' + key : key;
        if (interesting.test(key)) {
          matches.push({
            path: childPath,
            type: Array.isArray(child) ? 'array' : typeof child,
            stringLength: typeof child === 'string' ? child.length : null,
          });
          if (matches.length >= 200) return;
        }
        walk(child, childPath, depth + 1);
        if (matches.length >= 200) return;
      }
    };

    let fiber = card[fiberKey];
    let fiberDepth = 0;
    while (fiber && fiberDepth < 20 && matches.length < 200) {
      walk(fiber.memoizedProps, 'fiber' + fiberDepth + '.memoizedProps', 0);
      walk(fiber.memoizedState, 'fiber' + fiberDepth + '.memoizedState', 0);
      fiber = fiber.return;
      fiberDepth += 1;
    }
    return { ok: true, fiberDepth, visited, matches };
  })()`;
}

export function buildProbeAwemeDetailVariantsExpression() {
  return `(async () => {
    const card = document.querySelector('.MessageItemShareAwemecontainer');
    if (!card) return { ok: false, reason: 'aweme-card-not-found' };
    const fiberKey = Object.keys(card).find((key) => key.startsWith('__reactFiber$'));
    let fiber = fiberKey ? card[fiberKey] : null;
    let itemId = null;
    for (let depth = 0; fiber && depth < 20 && !itemId; depth += 1, fiber = fiber.return) {
      itemId = fiber.memoizedProps?.message?.parsedContent?.itemId || null;
    }
    if (!itemId) return { ok: false, reason: 'aweme-item-id-not-found' };

    const response = await fetch('/aweme/v1/web/aweme/detail/?aweme_id=' + encodeURIComponent(itemId), {
      credentials: 'include',
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, reason: 'aweme-detail-not-json', status: response.status };
    }
    const detail = payload?.aweme_detail;
    const video = detail?.video;
    const variants = Array.isArray(video?.bit_rate) ? video.bit_rate.map((variant) => ({
      codecType: variant?.codec_type ?? null,
      gearName: variant?.gear_name ?? null,
      qualityType: variant?.quality_type ?? null,
      urlCount: variant?.play_addr?.url_list?.length ?? 0,
    })) : [];
    return {
      ok: response.ok && Boolean(detail),
      status: response.status,
      payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 30) : [],
      detailFound: Boolean(detail),
      videoFound: Boolean(video),
      videoKeys: video && typeof video === 'object' ? Object.keys(video).slice(0, 60) : [],
      variants,
      playAddrUrlCount: video?.play_addr?.url_list?.length ?? 0,
      playAddr265UrlCount: video?.play_addr_265?.url_list?.length ?? 0,
      playAddrH264UrlCount: video?.play_addr_h264?.url_list?.length ?? 0,
    };
  })()`;
}

export function buildReadCompatibleAwemeSourceExpression() {
  return `(async () => {
    const list = document.querySelector(${JSON.stringify(DOUYIN_CHAT_LIST_SELECTOR)});
    if (!list) return { ok: false, reason: 'message-list-not-found' };
    const messages = Array.from(list.querySelectorAll(${JSON.stringify(DOUYIN_MESSAGE_SELECTOR)}))
      .sort((left, right) => right.getBoundingClientRect().top - left.getBoundingClientRect().top);
    let card = null;
    for (const message of messages) {
      ${MESSAGE_SIDE_CAPTURE_SOURCE}
      if (side !== 'left') continue;
      const candidate = message.querySelector('.MessageItemShareAwemecontainer');
      if (!candidate) continue;
      card = candidate;
      break;
    }
    if (!card) return { ok: false, reason: 'aweme-card-not-found' };
    const fiberKey = Object.keys(card).find((key) => key.startsWith('__reactFiber$'));
    let fiber = fiberKey ? card[fiberKey] : null;
    let itemId = null;
    for (let depth = 0; fiber && depth < 20 && !itemId; depth += 1, fiber = fiber.return) {
      itemId = fiber.memoizedProps?.message?.parsedContent?.itemId || null;
    }
    if (!itemId) return { ok: false, reason: 'aweme-item-id-not-found' };

    const response = await fetch('/aweme/v1/web/aweme/detail/?aweme_id=' + encodeURIComponent(itemId), {
      credentials: 'include',
    });
    if (!response.ok) return { ok: false, reason: 'aweme-detail-request-failed' };
    const payload = await response.json();
    const video = payload?.aweme_detail?.video;
    const h264Urls = video?.play_addr_h264?.url_list;
    const defaultUrls = video?.play_addr?.url_list;
    const source = (Array.isArray(h264Urls) && h264Urls.find(Boolean)) ||
      (Array.isArray(defaultUrls) && defaultUrls.find(Boolean)) || '';
    if (!source) return { ok: false, reason: 'compatible-video-source-not-found' };
    return { ok: true, source, selectedCodec: Array.isArray(h264Urls) && h264Urls.length ? 'h264' : 'default' };
  })()`;
}

export function buildReadCompatibleAwemeMediaExpression() {
  return `(async () => {
    const list = document.querySelector(${JSON.stringify(DOUYIN_CHAT_LIST_SELECTOR)});
    if (!list) return { ok: false, reason: 'message-list-not-found' };
    const messages = Array.from(list.querySelectorAll(${JSON.stringify(DOUYIN_MESSAGE_SELECTOR)}))
      .sort((left, right) => right.getBoundingClientRect().top - left.getBoundingClientRect().top);
    let card = null;
    for (const message of messages) {
      ${MESSAGE_SIDE_CAPTURE_SOURCE}
      if (side !== 'left') continue;
      const candidate = message.querySelector('.MessageItemShareAwemecontainer');
      if (!candidate) continue;
      card = candidate;
      break;
    }
    if (!card) return { ok: false, reason: 'aweme-card-not-found' };
    const fiberKey = Object.keys(card).find((key) => key.startsWith('__reactFiber$'));
    let fiber = fiberKey ? card[fiberKey] : null;
    let parsedContent = null;
    for (let depth = 0; fiber && depth < 20 && !parsedContent; depth += 1, fiber = fiber.return) {
      const candidate = fiber.memoizedProps?.message?.parsedContent;
      if (candidate && typeof candidate === 'object') parsedContent = candidate;
    }
    const itemId = parsedContent?.itemId || null;
    let detail = null;
    if (itemId) {
      try {
        const response = await fetch('/aweme/v1/web/aweme/detail/?aweme_id=' + encodeURIComponent(itemId), {
          credentials: 'include',
        });
        if (response.ok) {
          const payload = await response.json();
          detail = payload?.aweme_detail || null;
        }
      } catch {
        detail = null;
      }
    }
    const video = detail?.video;
    const h264Urls = video?.play_addr_h264?.url_list;
    const defaultUrls = video?.play_addr?.url_list;
    const videoSource = (Array.isArray(h264Urls) && h264Urls.find(Boolean)) ||
      (Array.isArray(defaultUrls) && defaultUrls.find(Boolean)) || '';
    if (videoSource) {
      return {
        ok: true,
        mediaType: 'video',
        source: videoSource,
        selectedCodec: Array.isArray(h264Urls) && h264Urls.length ? 'h264' : 'default',
      };
    }
    const imageCandidates = [
      detail?.images,
      detail?.image_post_info?.images,
      detail?.image_post_info?.image_list,
    ].find((candidate) => Array.isArray(candidate) && candidate.length > 0) || [];
    const allSources = imageCandidates.map((image) => {
      const lists = [
        image?.url_list,
        image?.download_url_list,
        image?.display_image?.url_list,
        image?.image?.url_list,
        image?.owner_watermark_image?.url_list,
      ];
      for (const urls of lists) {
        if (Array.isArray(urls)) {
          const source = urls.find((value) => typeof value === 'string' && value.length > 0);
          if (source) return source;
        }
      }
      return null;
    }).filter(Boolean);
    if (allSources.length > 0) {
      const maxImages = 12;
      const selectedIndexes = allSources.length <= maxImages
        ? allSources.map((_, index) => index)
        : Array.from({ length: maxImages }, (_, index) =>
          Math.round(index * (allSources.length - 1) / (maxImages - 1))
        );
      return {
        ok: true,
        mediaType: 'image_post',
        sources: selectedIndexes.map((index) => allSources[index]),
        totalImageCount: allSources.length,
        sampled: allSources.length > maxImages,
      };
    }
    const coverLists = [
      parsedContent?.cover_url_v2?.url_list,
      parsedContent?.cover_url?.url_list,
      parsedContent?.content_thumb?.url_list,
    ];
    for (const urls of coverLists) {
      if (!Array.isArray(urls)) continue;
      const source = urls.find((value) => typeof value === 'string' && value.length > 0);
      if (source) {
        return {
          ok: true,
          mediaType: 'shared_cover',
          sources: [source],
          totalImageCount: 1,
          sampled: false,
        };
      }
    }
    return { ok: false, reason: 'compatible-aweme-media-not-found' };
  })()`;
}

export function buildReadIncomingMediaTextExpression(message) {
  if (!Number.isSafeInteger(message?.ordinalFromEnd) || message.ordinalFromEnd < 1 || message.ordinalFromEnd > 12
      || !/^[0-9a-f]{64}$/u.test(message?.fingerprint)
      || message?.kind !== "media" || message?.side !== "left") {
    throw new Error("Incoming media metadata is invalid.");
  }
  const expected = {
    ordinalFromEnd: message.ordinalFromEnd,
    fingerprint: message.fingerprint,
  };
  return `(async () => {
    ${CHAT_IDENTITY_CAPTURE_SOURCE}
    const list = document.querySelector(${JSON.stringify(DOUYIN_CHAT_LIST_SELECTOR)});
    if (!list) return { ok: false, reason: 'message-list-not-found', text: null };
    const expected = ${JSON.stringify(expected)};
    const digest = async (value) => {
      const bytes = new TextEncoder().encode(value);
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
    };
    const recent = Array.from(list.querySelectorAll(${JSON.stringify(DOUYIN_MESSAGE_SELECTOR)}))
      .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)
      .slice(-12);
    const message = recent[recent.length - expected.ordinalFromEnd];
    if (!message) return { ok: false, reason: 'incoming-media-not-visible', text: null };
    const bubble = message.querySelector(${JSON.stringify(DOUYIN_TEXT_BUBBLE_SELECTOR)});
    ${MESSAGE_SIDE_CAPTURE_SOURCE}
    const hasMedia = Boolean(message.querySelector(
      '.MessageItemShareAwemecontainer, .MessageItemImageImageBox, video, canvas, [class*="Video"], [class*="Aweme"], [class*="Card"]'
    ));
    if (side !== 'left' || !hasMedia) {
      return { ok: false, reason: 'incoming-media-identity-changed', text: null };
    }
    const source = (bubble?.textContent || message.textContent || '').trim();
    const fingerprint = await digest(['media', side, source].join('|'));
    if (fingerprint !== expected.fingerprint) {
      return { ok: false, reason: 'incoming-media-fingerprint-changed', text: null };
    }
    return {
      ok: true,
      chatFingerprint: opaqueId ? await digest(['douyin-opponent-v1', opaqueId].join('|')) : null,
      text: (bubble?.textContent || '').trim() || null,
    };
  })()`;
}

export function buildReadLatestIncomingTextExpression() {
  return `(() => {
    const list = document.querySelector(${JSON.stringify(DOUYIN_CHAT_LIST_SELECTOR)});
    if (!list) return { ok: false, reason: 'message-list-not-found' };

    const messages = Array.from(list.querySelectorAll(${JSON.stringify(DOUYIN_MESSAGE_SELECTOR)}))
      .sort((left, right) =>
        right.getBoundingClientRect().top - left.getBoundingClientRect().top
      );
    for (const message of messages) {
      ${MESSAGE_SIDE_CAPTURE_SOURCE}
      if (side !== 'left') continue;
      const textBubble = message.querySelector(${JSON.stringify(DOUYIN_TEXT_BUBBLE_SELECTOR)});
      if (!textBubble) continue;

      const text = (textBubble.textContent || '').trim();
      if (!text) continue;
      return { ok: true, text };
    }

    return { ok: false, reason: 'incoming-text-not-found' };
  })()`;
}

export function buildReadIncomingTextBatchExpression(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 12) {
    throw new Error("A bounded incoming text batch is required.");
  }
  const expected = messages.map((message) => {
    if (!Number.isSafeInteger(message?.ordinalFromEnd) || message.ordinalFromEnd < 1 || message.ordinalFromEnd > 12) {
      throw new Error("Incoming text ordinal is invalid.");
    }
    if (!/^[0-9a-f]{64}$/u.test(message?.fingerprint) || message?.kind !== "text" || message?.side !== "left") {
      throw new Error("Incoming text metadata is invalid.");
    }
    return {
      ordinalFromEnd: message.ordinalFromEnd,
      fingerprint: message.fingerprint,
    };
  });

  return `(async () => {
    ${CHAT_IDENTITY_CAPTURE_SOURCE}
    const list = document.querySelector(${JSON.stringify(DOUYIN_CHAT_LIST_SELECTOR)});
    if (!list) return { ok: false, reason: 'message-list-not-found', texts: [] };
    const expected = ${JSON.stringify(expected)};
    const digest = async (value) => {
      const bytes = new TextEncoder().encode(value);
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
    };
    const recent = Array.from(list.querySelectorAll(${JSON.stringify(DOUYIN_MESSAGE_SELECTOR)}))
      .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)
      .slice(-12);
    const captured = [];
    for (const descriptor of expected) {
      const message = recent[recent.length - descriptor.ordinalFromEnd];
      const bubble = message?.querySelector(${JSON.stringify(DOUYIN_TEXT_BUBBLE_SELECTOR)});
      if (!message || !bubble) return { ok: false, reason: 'incoming-text-not-visible', texts: [] };
      ${MESSAGE_SIDE_CAPTURE_SOURCE}
      if (side !== 'left') return { ok: false, reason: 'incoming-text-side-changed', texts: [] };
      const text = (bubble.textContent || '').trim();
      if (!text) return { ok: false, reason: 'incoming-text-empty', texts: [] };
      captured.push({ descriptor, text, structuralKey: ['text', 'left', text].join('|') });
    }
    const texts = [];
    for (const message of captured) {
      if (await digest(message.structuralKey) !== message.descriptor.fingerprint) {
        return { ok: false, reason: 'incoming-text-fingerprint-changed', texts: [] };
      }
      texts.push(message.text);
    }
    return {
      ok: true,
      chatFingerprint: opaqueId ? await digest(['douyin-opponent-v1', opaqueId].join('|')) : null,
      texts,
    };
  })()`;
}

export function buildReadRecentConversationExpression(limit = 12) {
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 12, 30));
  return `(async () => {
    const list = document.querySelector(${JSON.stringify(DOUYIN_CHAT_LIST_SELECTOR)});
    if (!list) return { ok: false, messages: [] };
    const digest = async (value) => {
      const bytes = new TextEncoder().encode(value);
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
    };
    const ordered = Array.from(list.querySelectorAll(${JSON.stringify(DOUYIN_MESSAGE_SELECTOR)}))
      .sort((left, right) =>
        left.getBoundingClientRect().top - right.getBoundingClientRect().top
      );
    const messages = [];
    for (const message of ordered) {
      const bubble = message.querySelector(${JSON.stringify(DOUYIN_TEXT_BUBBLE_SELECTOR)});
      if (!bubble) continue;
      ${MESSAGE_SIDE_CAPTURE_SOURCE}
      const role = side === 'left' ? 'user' : side === 'right' ? 'assistant' : null;
      const text = (bubble.textContent || '').trim();
      if (role && text) messages.push({
        role,
        text,
        fingerprint: await digest(['text', side, text].join('|')),
      });
    }
    return { ok: true, messages: messages.slice(-${safeLimit}) };
  })()`;
}

export function normalizeOutboundText(text, maxLength = 800) {
  return String(text ?? "")
    .replace(/\r?\n+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

export function buildChatEditorMetadataExpression() {
  return `(() => {
    const editor = document.querySelector(${JSON.stringify(DOUYIN_CHAT_INPUT_SELECTOR)});
    if (!editor) return { found: false, textLength: 0, childCount: 0 };
    return {
      found: true,
      textLength: (editor.textContent || '').replace(/[\u200B\uFEFF]/gu, '').trim().length,
      childCount: editor.children.length,
      paragraphCount: editor.querySelectorAll('p').length,
      focused: document.activeElement === editor,
    };
  })()`;
}

export function buildChatIdentityMetadataExpression() {
  return `(async () => {
    ${CHAT_IDENTITY_CAPTURE_SOURCE}
    if (!title) return { found: false, fingerprint: null };
    if (!opaqueId) return { found: false, fingerprint: null };
    const bytes = new TextEncoder().encode(['douyin-opponent-v1', opaqueId].join('|'));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const fingerprint = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return { found: true, fingerprint };
  })()`;
}

export function isDouyinChatTarget(target) {
  if (target?.type !== "page" || typeof target.webSocketDebuggerUrl !== "string") {
    return false;
  }

  try {
    const url = new URL(target.url);
    return (
      url.protocol === "https:" &&
      (url.hostname === "douyin.com" || url.hostname.endsWith(".douyin.com")) &&
      url.pathname.startsWith("/chat")
    );
  } catch {
    return false;
  }
}
