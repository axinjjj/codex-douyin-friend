import { buildReadCompatibleAwemeMediaExpression } from "./douyin-chat-page.mjs";
import {
  captureLatestDouyinChatImage,
  prepareDouyinImagePost,
} from "./douyin-image-runtime.mjs";
import { resolveDouyinSharedWorkPlayerFallback } from "./douyin-player-runtime.mjs";
import { prepareLatestDouyinVideoMedia } from "./douyin-video-runtime.mjs";
import {
  createDouyinMediaEvidence,
  DOUYIN_EVIDENCE_MODES,
  isDouyinCoverFallbackEligible,
} from "./douyin-media-evidence.mjs";

const directImageAdapter = Object.freeze({
  key: "direct-image",
  mediaTypes: Object.freeze(["chat_image"]),
  async acquire(context, dependencies) {
    const prepared = await dependencies.captureChatImage({
      cdp: context.cdp,
      projectRoot: context.projectRoot,
      mediaMessage: context.mediaMessage,
    });
    return {
      kind: "chat_image",
      ...prepared,
      evidence: createDouyinMediaEvidence({
        mode: DOUYIN_EVIDENCE_MODES.DIRECT_IMAGE,
        assetCount: prepared.imagePaths?.length ?? 1,
      }),
    };
  },
});

const videoManifestHandler = Object.freeze({
  key: "video",
  mediaTypes: Object.freeze(["video"]),
  async prepare(context, dependencies, manifest) {
    const prepared = await dependencies.prepareVideo({
      cdp: context.cdp,
      projectRoot: context.projectRoot,
      port: context.port,
      sourceResult: manifest,
      analyzeAudio: context.analyzeAudio,
    });
    const allSampledFramesBlack = prepared.sampling?.selectedFrameCount > 0
      && prepared.sampling.blankCapturedFrameCount === prepared.sampling.selectedFrameCount;
    return {
      kind: "video",
      ...prepared,
      evidence: createDouyinMediaEvidence({
        mode: allSampledFramesBlack
          ? DOUYIN_EVIDENCE_MODES.DECODED_BLACK
          : DOUYIN_EVIDENCE_MODES.COMPLETE_VIDEO,
        assetCount: prepared.framePaths?.length ?? 1,
        audioStatus: prepared.audioUnderstanding?.processed ? "processed" : "unavailable",
        limitations: [
          ...(allSampledFramesBlack ? ["sampled-frames-all-black"] : []),
          ...(!prepared.audioUnderstanding?.processed ? ["audio-unavailable"] : []),
        ],
      }),
    };
  },
});

const imagePostManifestHandler = Object.freeze({
  key: "image-post",
  mediaTypes: Object.freeze(["image_post"]),
  async prepare(context, dependencies, manifest) {
    const prepared = await dependencies.prepareImagePost({ projectRoot: context.projectRoot, manifest });
    return {
      ...prepared,
      evidence: createDouyinMediaEvidence({
        mode: prepared.partial
          ? DOUYIN_EVIDENCE_MODES.PARTIAL_IMAGES
          : DOUYIN_EVIDENCE_MODES.COMPLETE_IMAGES,
        assetCount: prepared.imagePaths?.length ?? 1,
        totalAssetCount: prepared.totalImageCount ?? manifest.totalImageCount
          ?? prepared.imagePaths?.length ?? 1,
        limitations: prepared.partial ? ["some-selected-images-unavailable"] : [],
      }),
    };
  },
});

const coverManifestHandler = Object.freeze({
  key: "cover-only",
  mediaTypes: Object.freeze(["shared_cover"]),
  async prepare(context, dependencies, manifest) {
    const prepared = await dependencies.prepareImagePost({ projectRoot: context.projectRoot, manifest });
    return {
      ...prepared,
      evidence: createDouyinMediaEvidence({
        mode: DOUYIN_EVIDENCE_MODES.COVER_ONLY,
        assetCount: prepared.imagePaths?.length ?? 1,
        totalAssetCount: manifest.totalImageCount ?? prepared.imagePaths?.length ?? 1,
        audioStatus: "unavailable",
        limitations: ["work-content-unavailable", "audio-unavailable"],
      }),
    };
  },
});

export const DOUYIN_SHARED_MANIFEST_HANDLER_REGISTRY = Object.freeze([
  videoManifestHandler,
  imagePostManifestHandler,
  coverManifestHandler,
]);

function matchUniqueRegistryEntry(mediaType, registry, methodName) {
  if (!Array.isArray(registry)) throw new Error("The Douyin media registry is invalid.");
  const matches = registry.filter((entry) => (
    entry && typeof entry[methodName] === "function"
      && Array.isArray(entry.mediaTypes)
      && entry.mediaTypes.includes(mediaType)
  ));
  if (matches.length > 1) {
    throw new Error(`Multiple Douyin media registry entries matched ${String(mediaType)}.`);
  }
  return matches[0] || null;
}

async function acquireSharedWork(context, dependencies) {
  let manifest = await dependencies.readSharedWorkManifest(context);
  if (!manifest?.ok) {
    throw new Error(`The shared Douyin work is unavailable: ${manifest?.reason || "unknown"}.`);
  }
  let coverFallback = manifest.mediaType === "shared_cover" ? manifest : null;
  if (!coverFallback && Array.isArray(manifest.coverSources) && manifest.coverSources.length > 0) {
    coverFallback = {
      ok: true,
      mediaType: "shared_cover",
      sources: [manifest.coverSources[0]],
      sourceCandidates: [manifest.coverSources.slice(0, 4)],
      totalImageCount: 1,
      sampled: false,
      originalMediaType: "video",
    };
  }
  if (manifest.mediaType === "shared_cover") {
    const fallback = await dependencies.resolvePlayerFallback({
      cdp: context.cdp,
      projectRoot: context.projectRoot,
      mediaMessage: context.mediaMessage,
      expectedChatFingerprint: context.expectedChatFingerprint,
      initialManifest: manifest,
    });
    if (fallback?.kind === "media") return fallback.media;
    if (fallback?.kind !== "manifest" || !fallback.manifest?.ok) {
      throw new Error("The shared Douyin player fallback returned an invalid result.");
    }
    manifest = fallback.manifest;
  }
  const handler = matchUniqueRegistryEntry(
    manifest.mediaType,
    DOUYIN_SHARED_MANIFEST_HANDLER_REGISTRY,
    "prepare",
  );
  if (!handler) throw new Error("The shared Douyin work type is unsupported.");
  try {
    return await handler.prepare(context, dependencies, manifest);
  } catch (error) {
    if (!isDouyinCoverFallbackEligible(error)) throw error;
    if (!coverFallback) throw error;
    return coverManifestHandler.prepare(context, dependencies, coverFallback);
  }
}

const sharedWorkAdapter = Object.freeze({
  key: "shared-work",
  mediaTypes: Object.freeze(["shared_aweme"]),
  acquire: acquireSharedWork,
});

const commentShareAdapter = Object.freeze({
  key: "comment-share",
  mediaTypes: Object.freeze(["comment_share"]),
  acquire: acquireSharedWork,
});

export const DOUYIN_MEDIA_ADAPTER_REGISTRY = Object.freeze([
  directImageAdapter,
  sharedWorkAdapter,
  commentShareAdapter,
]);

export function matchDouyinMediaAdapter(
  mediaType,
  registry = DOUYIN_MEDIA_ADAPTER_REGISTRY,
) {
  return matchUniqueRegistryEntry(mediaType, registry, "acquire");
}

export async function acquireDouyinMedia({
  mediaType,
  cdp,
  projectRoot,
  port = 9229,
  mediaMessage,
  expectedChatFingerprint,
  analyzeAudio = null,
  registry = DOUYIN_MEDIA_ADAPTER_REGISTRY,
  dependencies = {},
} = {}) {
  const adapter = matchDouyinMediaAdapter(mediaType, registry);
  if (!adapter) throw new Error("The latest Douyin media type is unsupported.");
  const resolvedDependencies = {
    captureChatImage: dependencies.captureChatImage || captureLatestDouyinChatImage,
    readSharedWorkManifest: dependencies.readSharedWorkManifest || (async (context) => (
      context.cdp.evaluate(buildReadCompatibleAwemeMediaExpression(context.mediaMessage), 15_000)
    )),
    resolvePlayerFallback: dependencies.resolvePlayerFallback
      || resolveDouyinSharedWorkPlayerFallback,
    prepareVideo: dependencies.prepareVideo || prepareLatestDouyinVideoMedia,
    prepareImagePost: dependencies.prepareImagePost || prepareDouyinImagePost,
  };
  return adapter.acquire({
    mediaType,
    cdp,
    projectRoot,
    port,
    mediaMessage,
    expectedChatFingerprint,
    analyzeAudio,
  }, resolvedDependencies);
}
