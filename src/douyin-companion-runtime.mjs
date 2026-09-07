import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

const COMPANION_DIRECTORY_SEGMENTS = ["CodexDouyinFriend", "companion"];

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function resolveDouyinCompanionCwd({ localAppData = process.env.LOCALAPPDATA } = {}) {
  if (typeof localAppData !== "string" || !path.isAbsolute(localAppData)) {
    throw new Error("A valid absolute LOCALAPPDATA path is required for the companion runtime.");
  }
  return path.join(localAppData, ...COMPANION_DIRECTORY_SEGMENTS);
}

export async function ensureDouyinCompanionCwd({
  projectRoot,
  localAppData = process.env.LOCALAPPDATA,
} = {}) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    throw new Error("An absolute project root is required for the companion runtime.");
  }
  const requested = resolveDouyinCompanionCwd({ localAppData });
  await mkdir(requested, { recursive: true });
  const [resolvedProjectRoot, resolvedCompanionCwd] = await Promise.all([
    realpath(projectRoot),
    realpath(requested),
  ]);
  if (isWithin(resolvedProjectRoot, resolvedCompanionCwd)) {
    throw new Error("The companion runtime directory must remain outside the repository.");
  }
  return resolvedCompanionCwd;
}
