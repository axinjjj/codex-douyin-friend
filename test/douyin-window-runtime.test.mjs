import test from "node:test";
import assert from "node:assert/strict";
import { repairCollapsedDouyinViewport } from "../src/douyin-window-runtime.mjs";

test("leaves a healthy Douyin viewport unchanged", async () => {
  const requests = [];
  const result = await repairCollapsedDouyinViewport({
    cdp: {
      async evaluate() {
        return { innerWidth: 1000, innerHeight: 700, outerWidth: 1050, outerHeight: 800 };
      },
      async request(...args) {
        requests.push(args);
      },
    },
    targetId: "target-1",
  });
  assert.deepEqual(result, { repaired: false, ready: true });
  assert.equal(requests.length, 0);
});

test("does not restore a deliberately minimized Edge window", async () => {
  const calls = [];
  const result = await repairCollapsedDouyinViewport({
    cdp: {
      async evaluate() {
        return { innerWidth: 224, innerHeight: 102, outerWidth: 1052, outerHeight: 798 };
      },
      async request(method) {
        calls.push(method);
        return { windowId: 7, bounds: { windowState: "minimized" } };
      },
    },
    targetId: "target-1",
  });
  assert.deepEqual(result, { repaired: false, ready: false, reason: "window-not-normal" });
  assert.deepEqual(calls, ["Browser.getWindowForTarget"]);
});

test("repairs a collapsed renderer by nudging and restoring the exact normal window", async () => {
  const requests = [];
  let viewportRead = 0;
  const result = await repairCollapsedDouyinViewport({
    cdp: {
      async evaluate() {
        viewportRead += 1;
        return viewportRead === 1
          ? { innerWidth: 224, innerHeight: 102, outerWidth: 1052, outerHeight: 798 }
          : { innerWidth: 1030, innerHeight: 708, outerWidth: 1052, outerHeight: 798 };
      },
      async request(method, params) {
        requests.push({ method, params });
        if (method === "Browser.getWindowForTarget") {
          return {
            windowId: 7,
            bounds: { left: 10, top: 10, width: 1052, height: 798, windowState: "normal" },
          };
        }
        return {};
      },
    },
    targetId: "target-1",
    sleepFn: async () => {},
  });
  assert.deepEqual(result, { repaired: true, ready: true });
  assert.deepEqual(requests, [
    { method: "Browser.getWindowForTarget", params: { targetId: "target-1" } },
    {
      method: "Browser.setWindowBounds",
      params: {
        windowId: 7,
        bounds: { left: 10, top: 10, width: 1051, height: 798, windowState: "normal" },
      },
    },
    {
      method: "Browser.setWindowBounds",
      params: {
        windowId: 7,
        bounds: { left: 10, top: 10, width: 1052, height: 798, windowState: "normal" },
      },
    },
  ]);
});
