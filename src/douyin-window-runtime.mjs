const MIN_CHAT_VIEWPORT_WIDTH = 400;
const MIN_CHAT_VIEWPORT_HEIGHT = 250;
const MIN_NORMAL_WINDOW_WIDTH = 600;
const MIN_NORMAL_WINDOW_HEIGHT = 400;

const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function repairCollapsedDouyinViewport({
  cdp,
  targetId,
  sleepFn = defaultSleep,
} = {}) {
  if (!cdp || typeof cdp.evaluate !== "function" || typeof cdp.request !== "function") {
    throw new Error("A connected CDP client is required for viewport repair.");
  }
  if (typeof targetId !== "string" || targetId.length === 0) {
    throw new Error("A Douyin target id is required for viewport repair.");
  }
  const readViewport = () => cdp.evaluate(`(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
  }))()`);
  const before = await readViewport();
  const collapsed = before?.innerWidth < MIN_CHAT_VIEWPORT_WIDTH
    || before?.innerHeight < MIN_CHAT_VIEWPORT_HEIGHT;
  if (!collapsed) return { repaired: false, ready: true };

  const windowInfo = await cdp.request("Browser.getWindowForTarget", { targetId });
  const bounds = windowInfo?.bounds;
  if (bounds?.windowState !== "normal") {
    return { repaired: false, ready: false, reason: "window-not-normal" };
  }
  if (!Number.isInteger(windowInfo.windowId)
      || !Number.isInteger(bounds.width) || bounds.width < MIN_NORMAL_WINDOW_WIDTH
      || !Number.isInteger(bounds.height) || bounds.height < MIN_NORMAL_WINDOW_HEIGHT
      || !Number.isInteger(bounds.left) || !Number.isInteger(bounds.top)) {
    throw new Error("Refusing to repair an invalid Douyin window boundary.");
  }

  await cdp.request("Browser.setWindowBounds", {
    windowId: windowInfo.windowId,
    bounds: {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width - 1,
      height: bounds.height,
      windowState: "normal",
    },
  });
  await sleepFn(100);
  await cdp.request("Browser.setWindowBounds", {
    windowId: windowInfo.windowId,
    bounds: {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
      windowState: "normal",
    },
  });
  await sleepFn(250);

  const after = await readViewport();
  if (after?.innerWidth < MIN_CHAT_VIEWPORT_WIDTH
      || after?.innerHeight < MIN_CHAT_VIEWPORT_HEIGHT) {
    throw new Error("The Douyin viewport remained collapsed after a bounded window refresh.");
  }
  return { repaired: true, ready: true };
}
