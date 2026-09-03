const DEFAULT_SIGNATURE_LEVELS = 15;

export const MAX_FINAL_FRAME_COUNT = 18;
export const MAX_SCAN_SAMPLE_COUNT = 72;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteIntegerOr(value, fallback) {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function requireDuration(durationSeconds) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Video duration must be a positive finite number.");
  }
  return duration;
}

function uniqueSortedTimes(values, minimumGapSeconds = 0.04) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  const result = [];
  for (const value of sorted) {
    if (result.length === 0 || value - result.at(-1) >= minimumGapSeconds) {
      result.push(value);
    }
  }
  return result;
}

function evenlySpacedTimes(start, end, count) {
  if (count <= 1 || end <= start) return [start];
  return Array.from({ length: count }, (_, index) => (
    start + (end - start) * index / (count - 1)
  ));
}

function selectDistributed(values, limit) {
  if (limit <= 0) return [];
  if (values.length <= limit) return [...values];
  if (limit === 1) return [values[0]];
  const selected = [];
  for (let index = 0; index < limit; index += 1) {
    selected.push(values[Math.round(index * (values.length - 1) / (limit - 1))]);
  }
  return selected;
}

function selectWeightedDistributed(values, limit) {
  if (values.length <= limit) return [...values];
  const selected = [];
  const weights = [...new Set(values.map((value) => value.weight ?? 1))]
    .sort((left, right) => right - left);
  for (const weight of weights) {
    const remaining = limit - selected.length;
    if (remaining <= 0) break;
    const group = values.filter((value) => (value.weight ?? 1) === weight);
    selected.push(...selectDistributed(group, remaining));
  }
  return selected.sort((left, right) => left.time - right.time);
}

export function getAdaptiveFramePlan(durationSeconds) {
  const duration = requireDuration(durationSeconds);
  if (duration <= 30) return { frameBudget: 5, scanBudget: 12 };
  if (duration <= 120) return { frameBudget: 8, scanBudget: 24 };
  if (duration <= 300) return { frameBudget: 12, scanBudget: 40 };
  if (duration <= 600) return { frameBudget: 16, scanBudget: 56 };
  return { frameBudget: MAX_FINAL_FRAME_COUNT, scanBudget: MAX_SCAN_SAMPLE_COUNT };
}

export function buildAudioAnchorsFromSegments(segments, durationSeconds, {
  maxAnchors = 24,
} = {}) {
  const duration = requireDuration(durationSeconds);
  const boundedLimit = clamp(Math.trunc(maxAnchors) || 0, 0, 48);
  if (boundedLimit === 0 || !Array.isArray(segments)) return [];

  const candidates = [];
  let previousTagKey = null;
  for (const segment of segments) {
    if (!Number.isFinite(segment?.startSeconds) || !Number.isFinite(segment?.endSeconds)) continue;
    const start = segment.startSeconds;
    const end = segment.endSeconds;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
    const boundedStart = clamp(start, 0, duration);
    const boundedEnd = clamp(end, 0, duration);
    if (boundedEnd <= boundedStart) continue;

    const emotions = Array.isArray(segment.emotions) ? segment.emotions : [];
    const events = Array.isArray(segment.events) ? segment.events : [];
    const tagKey = JSON.stringify([emotions, events]);
    candidates.push({ time: boundedStart, weight: 3, reason: "speech-start" });
    candidates.push({
      time: (boundedStart + boundedEnd) / 2,
      weight: emotions.some((value) => value !== "NEUTRAL")
        || events.some((value) => value !== "SPEECH") ? 4 : 2,
      reason: "speech-midpoint",
    });
    if (previousTagKey !== null && tagKey !== previousTagKey) {
      candidates.push({ time: boundedStart, weight: 5, reason: "audio-tag-change" });
    }
    previousTagKey = tagKey;
  }

  const merged = [];
  for (const candidate of candidates.sort((left, right) => left.time - right.time)) {
    const prior = merged.at(-1);
    if (prior && candidate.time - prior.time < 0.35) {
      if (candidate.weight > prior.weight) merged[merged.length - 1] = candidate;
    } else {
      merged.push(candidate);
    }
  }
  if (merged.length <= boundedLimit) return merged;

  const highPriority = merged.filter((candidate) => candidate.weight >= 4);
  const selectedHighPriority = selectDistributed(highPriority, Math.min(highPriority.length, boundedLimit));
  const selectedKeys = new Set(selectedHighPriority.map((candidate) => candidate.time));
  const remaining = merged.filter((candidate) => !selectedKeys.has(candidate.time));
  const selectedRemaining = selectDistributed(remaining, boundedLimit - selectedHighPriority.length);
  return [...selectedHighPriority, ...selectedRemaining].sort((left, right) => left.time - right.time);
}

export function buildAdaptiveScanTimes(durationSeconds, {
  scanBudget,
  audioAnchors = [],
} = {}) {
  const duration = requireDuration(durationSeconds);
  const defaultPlan = getAdaptiveFramePlan(duration);
  const boundedBudget = clamp(
    finiteIntegerOr(scanBudget, defaultPlan.scanBudget),
    2,
    MAX_SCAN_SAMPLE_COUNT,
  );
  const inset = Math.min(0.1, duration * 0.01);
  const start = inset;
  const end = Math.max(start, duration - inset);
  if (end - start < 0.04) return [duration / 2];

  const normalizedAnchors = audioAnchors
    .map((anchor) => typeof anchor === "number" ? { time: anchor, weight: 1 } : anchor)
    .filter((anchor) => Number.isFinite(anchor?.time))
    .map((anchor) => ({
      ...anchor,
      time: clamp(anchor.time, start, end),
      weight: Number.isFinite(anchor.weight) ? anchor.weight : 1,
    }))
    .sort((left, right) => left.time - right.time);
  const anchorSlotCount = Math.min(normalizedAnchors.length, Math.floor(boundedBudget / 3));
  const chosenAnchors = selectWeightedDistributed(normalizedAnchors, anchorSlotCount);
  const uniformCount = Math.max(2, boundedBudget - chosenAnchors.length);
  let times = uniqueSortedTimes([
    ...evenlySpacedTimes(start, end, uniformCount),
    ...chosenAnchors.map((anchor) => anchor.time),
  ]);

  if (times.length < boundedBudget) {
    for (const candidate of evenlySpacedTimes(start, end, boundedBudget)) {
      if (times.length >= boundedBudget) break;
      if (times.every((time) => Math.abs(time - candidate) >= 0.04)) {
        times.push(candidate);
        times.sort((left, right) => left - right);
      }
    }
  }
  return times.slice(0, boundedBudget);
}

export function computeVisualDifference(leftSignature, rightSignature, {
  signatureLevels = DEFAULT_SIGNATURE_LEVELS,
} = {}) {
  if (!Array.isArray(leftSignature) || !Array.isArray(rightSignature)
    || leftSignature.length === 0 || leftSignature.length !== rightSignature.length) {
    throw new Error("Visual signatures must be non-empty arrays of equal length.");
  }
  let leftMean = 0;
  let rightMean = 0;
  let rawDifference = 0;
  for (let index = 0; index < leftSignature.length; index += 1) {
    const left = Number(leftSignature[index]);
    const right = Number(rightSignature[index]);
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      throw new Error("Visual signatures must contain finite numbers.");
    }
    leftMean += left;
    rightMean += right;
    rawDifference += Math.abs(left - right);
  }
  leftMean /= leftSignature.length;
  rightMean /= rightSignature.length;
  rawDifference /= leftSignature.length * signatureLevels;

  let structuralDifference = 0;
  for (let index = 0; index < leftSignature.length; index += 1) {
    structuralDifference += Math.abs(
      (leftSignature[index] - leftMean) - (rightSignature[index] - rightMean),
    );
  }
  structuralDifference /= leftSignature.length * signatureLevels * 2;
  return clamp(rawDifference * 0.8 + structuralDifference * 0.2, 0, 1);
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function deriveSceneThreshold(scores, {
  minimumThreshold = 0.12,
  maximumThreshold = 0.65,
} = {}) {
  const finiteScores = scores.filter((score) => Number.isFinite(score) && score >= 0);
  if (finiteScores.length === 0) return minimumThreshold;
  const center = median(finiteScores);
  const deviation = median(finiteScores.map((score) => Math.abs(score - center)));
  return clamp(center + Math.max(0.04, deviation * 2.5), minimumThreshold, maximumThreshold);
}

export function findSceneChanges(samples, options = {}) {
  const differences = [];
  for (let index = 1; index < samples.length; index += 1) {
    differences.push({
      index,
      score: computeVisualDifference(samples[index - 1].signature, samples[index].signature),
    });
  }
  const threshold = deriveSceneThreshold(differences.map(({ score }) => score), options);
  return {
    threshold,
    changes: differences.filter(({ score }) => score >= threshold),
  };
}

function nearestSampleIndex(samples, targetTime) {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < samples.length; index += 1) {
    const distance = Math.abs(samples[index].time - targetTime);
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  }
  return bestIndex;
}

export function selectAdaptiveFrameSamples({
  samples,
  durationSeconds,
  frameBudget,
  audioAnchors = [],
  duplicateThreshold = 0.055,
}) {
  const duration = requireDuration(durationSeconds);
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("At least one scanned video sample is required.");
  }
  const orderedSamples = [...samples]
    .filter((sample) => Number.isFinite(sample?.time) && Array.isArray(sample?.signature))
    .sort((left, right) => left.time - right.time);
  if (orderedSamples.length === 0) throw new Error("No usable scanned video samples were returned.");
  const defaultPlan = getAdaptiveFramePlan(duration);
  const budget = clamp(
    finiteIntegerOr(frameBudget, defaultPlan.frameBudget),
    1,
    Math.min(MAX_FINAL_FRAME_COUNT, orderedSamples.length),
  );

  const selected = [];
  const selectedIndexes = new Set();
  const add = (index, reason, { preserveBoundary = false } = {}) => {
    if (selected.length >= budget || selectedIndexes.has(index)) return false;
    const sample = orderedSamples[index];
    if (!preserveBoundary && selected.some(({ sample: existing }) => (
      computeVisualDifference(existing.signature, sample.signature) < duplicateThreshold
    ))) return false;
    selectedIndexes.add(index);
    selected.push({ index, sample, reasons: [reason] });
    return true;
  };

  const openingIndex = nearestSampleIndex(orderedSamples, 0);
  const endingIndex = nearestSampleIndex(orderedSamples, duration);
  if (orderedSamples[openingIndex].time > 0.25
    || duration - orderedSamples[endingIndex].time > 0.25) {
    throw new Error("Opening or ending scan samples are missing.");
  }
  add(openingIndex, "opening", { preserveBoundary: true });
  if (orderedSamples.length > 1) {
    add(endingIndex, "ending", { preserveBoundary: true });
  }

  const coverageCount = Math.min(budget, Math.max(3, Math.ceil(budget * 0.55)));
  for (const target of evenlySpacedTimes(0, duration, coverageCount)) {
    add(nearestSampleIndex(orderedSamples, target), "coverage");
  }

  const remainingAnchors = audioAnchors
    .map((anchor) => typeof anchor === "number" ? { time: anchor, weight: 1 } : anchor)
    .filter((anchor) => Number.isFinite(anchor?.time))
    .map((anchor) => ({ ...anchor, weight: Number.isFinite(anchor.weight) ? anchor.weight : 1 }));
  const sceneResult = findSceneChanges(orderedSamples);
  const remainingSceneChanges = [...sceneResult.changes].sort((left, right) => (
    right.score - left.score || left.index - right.index
  ));
  const addNextScene = () => {
    while (remainingSceneChanges.length > 0) {
      const change = remainingSceneChanges.shift();
      if (add(change.index, "scene-change")) return true;
    }
    return false;
  };
  const addNextAudio = () => {
    while (remainingAnchors.length > 0) {
      let bestIndex = 0;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (let index = 0; index < remainingAnchors.length; index += 1) {
        const anchor = remainingAnchors[index];
        const timeNovelty = Math.min(...selected.map(({ sample }) => (
          Math.abs(sample.time - anchor.time) / duration
        )));
        const score = anchor.weight * 10 + timeNovelty;
        if (score > bestScore || (score === bestScore && anchor.time < remainingAnchors[bestIndex].time)) {
          bestIndex = index;
          bestScore = score;
        }
      }
      const [anchor] = remainingAnchors.splice(bestIndex, 1);
      if (add(nearestSampleIndex(orderedSamples, anchor.time), anchor.reason || "audio-anchor")) {
        return true;
      }
    }
    return false;
  };
  let preferScene = true;
  while (selected.length < budget
    && (remainingSceneChanges.length > 0 || remainingAnchors.length > 0)) {
    let added = preferScene ? addNextScene() : addNextAudio();
    if (!added) added = preferScene ? addNextAudio() : addNextScene();
    if (!added) break;
    preferScene = !preferScene;
  }

  while (selected.length < budget) {
    let best = null;
    for (let index = 0; index < orderedSamples.length; index += 1) {
      if (selectedIndexes.has(index)) continue;
      const sample = orderedSamples[index];
      const minimumTimeDistance = Math.min(...selected.map(({ sample: existing }) => (
        Math.abs(existing.time - sample.time) / duration
      )));
      const minimumVisualDifference = Math.min(...selected.map(({ sample: existing }) => (
        computeVisualDifference(existing.signature, sample.signature)
      )));
      if (minimumVisualDifference < duplicateThreshold) continue;
      const score = minimumTimeDistance * 0.65 + minimumVisualDifference * 0.35;
      if (!best || score > best.score || (score === best.score && index < best.index)) {
        best = { index, score };
      }
    }
    if (!best || !add(best.index, "coverage-fill")) break;
  }

  return {
    sceneThreshold: sceneResult.threshold,
    selected: selected
      .sort((left, right) => left.sample.time - right.sample.time)
      .map(({ sample, reasons }) => ({ ...sample, reasons })),
  };
}
