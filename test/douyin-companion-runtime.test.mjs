import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureDouyinCompanionCwd,
  resolveDouyinCompanionCwd,
} from "../src/douyin-companion-runtime.mjs";

test("resolves the companion runtime under absolute LOCALAPPDATA", () => {
  assert.equal(
    resolveDouyinCompanionCwd({ localAppData: "C:\\Users\\fixture\\AppData\\Local" }),
    "C:\\Users\\fixture\\AppData\\Local\\CodexDouyinFriend\\companion",
  );
  assert.throws(
    () => resolveDouyinCompanionCwd({ localAppData: "relative" }),
    /absolute LOCALAPPDATA/u,
  );
});

test("creates a real companion cwd outside the repository", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "douyin-companion-"));
  try {
    const projectRoot = path.join(temporaryRoot, "project");
    const localAppData = path.join(temporaryRoot, "local-app-data");
    await Promise.all([
      mkdir(projectRoot, { recursive: true }),
      mkdir(localAppData, { recursive: true }),
    ]);
    const companionCwd = await ensureDouyinCompanionCwd({ projectRoot, localAppData });
    assert.equal(companionCwd, await realpath(path.join(localAppData, "CodexDouyinFriend", "companion")));
    assert.equal(path.relative(await realpath(projectRoot), companionCwd).startsWith(".."), true);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
