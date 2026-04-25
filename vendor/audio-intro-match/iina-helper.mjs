#!/usr/bin/env node

// tools/iina-helper.js
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

// lib/math.js
function mean(values) {
  if (!values.length) {
    return 0;
  }
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}
function median(values) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}
function clamp(value, lower, upper) {
  return Math.max(lower, Math.min(upper, value));
}
function safeLog10(value, floor = 1e-12) {
  return Math.log10(Math.max(value, floor));
}
function round4(value) {
  return Number(value.toFixed(4));
}
function secondsToHms(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  const s = seconds % 60;
  if (h) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function dotProduct(a, b) {
  let total = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    total += a[index] * b[index];
  }
  return total;
}
function stddev(values, avg = mean(values)) {
  if (!values.length) {
    return 0;
  }
  let variance = 0;
  for (const value of values) {
    variance += (value - avg) ** 2;
  }
  return Math.sqrt(variance / values.length);
}
function prefixSums(values) {
  const prefix = new Float64Array(values.length + 1);
  for (let index = 0; index < values.length; index += 1) {
    prefix[index + 1] = prefix[index] + values[index];
  }
  return prefix;
}
function rangeMean(prefix, start, end) {
  const length = end - start;
  if (length <= 0) {
    return 0;
  }
  return (prefix[end] - prefix[start]) / length;
}
function lexicographicDescending(keysA, keysB) {
  for (let index = 0; index < keysA.length; index += 1) {
    if (keysA[index] > keysB[index]) {
      return -1;
    }
    if (keysA[index] < keysB[index]) {
      return 1;
    }
  }
  return 0;
}

// lib/audio-features.js
var MEL_BANDS = 32;
var fftWorkReal = null;
var fftWorkImag = null;
var fftWorkPowers = null;
var hannWindowCache = /* @__PURE__ */ new Map();
var melFiltersCache = /* @__PURE__ */ new Map();
function getHannWindow(length) {
  if (!hannWindowCache.has(length)) {
    const win = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (length - 1)));
    }
    hannWindowCache.set(length, win);
  }
  return hannWindowCache.get(length);
}
function fftIterative(real, imag) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = real[i];
      real[i] = real[j];
      real[j] = tr;
      const ti = imag[i];
      imag[i] = imag[j];
      imag[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = -2 * Math.PI / len;
    const wlenR = Math.cos(angle);
    const wlenI = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wR = 1;
      let wI = 0;
      for (let j = 0; j < halfLen; j += 1) {
        const tr = real[i + j + halfLen] * wR - imag[i + j + halfLen] * wI;
        const ti = real[i + j + halfLen] * wI + imag[i + j + halfLen] * wR;
        real[i + j + halfLen] = real[i + j] - tr;
        imag[i + j + halfLen] = imag[i + j] - ti;
        real[i + j] += tr;
        imag[i + j] += ti;
        const nextWR = wR * wlenR - wI * wlenI;
        wI = wR * wlenI + wI * wlenR;
        wR = nextWR;
      }
    }
  }
}
function getMelFilterBank(sampleRate, fftSize, numBands, minFreq, maxFreq) {
  const minMel = 2595 * Math.log10(1 + minFreq / 700);
  const maxMel = 2595 * Math.log10(1 + maxFreq / 700);
  const melPoints = new Float32Array(numBands + 2);
  for (let i = 0; i < numBands + 2; i += 1) {
    melPoints[i] = minMel + i * (maxMel - minMel) / (numBands + 1);
  }
  const freqPoints = melPoints.map((mel) => 700 * (10 ** (mel / 2595) - 1));
  const binPoints = freqPoints.map((f) => Math.floor((fftSize + 1) * f / sampleRate));
  const filters = [];
  for (let i = 0; i < numBands; i += 1) {
    const start = binPoints[i];
    const mid = binPoints[i + 1];
    const end = binPoints[i + 2];
    filters.push({
      start,
      mid,
      end,
      riseDivisor: Math.max(1, mid - start),
      fallDivisor: Math.max(1, end - mid)
    });
  }
  return filters;
}
function getCachedMelFilters(sampleRate, fftSize) {
  const key = `${sampleRate}:${fftSize}`;
  if (!melFiltersCache.has(key)) {
    melFiltersCache.set(key, getMelFilterBank(sampleRate, fftSize, MEL_BANDS, 80, 3400));
  }
  return melFiltersCache.get(key);
}
function frameFeatures(samples, sampleRate) {
  if (!samples.length) {
    return {
      mel: new Float32Array(MEL_BANDS),
      rmsDb: -120
    };
  }
  const sampleCount = samples.length;
  let squaredSum = 0;
  for (const sample of samples) {
    squaredSum += sample * sample;
  }
  const rms = Math.sqrt(squaredSum / sampleCount);
  const rmsDb = 20 * safeLog10(rms / 32768);
  const fftSize = 1 << Math.ceil(Math.log2(sampleCount));
  if (!fftWorkReal || fftWorkReal.length !== fftSize) {
    fftWorkReal = new Float32Array(fftSize);
    fftWorkImag = new Float32Array(fftSize);
    fftWorkPowers = new Float32Array(fftSize / 2 + 1);
  } else {
    fftWorkReal.fill(0);
    fftWorkImag.fill(0);
  }
  const win = getHannWindow(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    fftWorkReal[i] = samples[i] * win[i];
  }
  fftIterative(fftWorkReal, fftWorkImag);
  const half = fftSize / 2;
  for (let i = 0; i <= half; i += 1) {
    fftWorkPowers[i] = fftWorkReal[i] ** 2 + fftWorkImag[i] ** 2;
  }
  const filters = getCachedMelFilters(sampleRate, fftSize);
  const mel = new Float32Array(filters.length);
  let melTotal = 0;
  for (let band = 0; band < filters.length; band += 1) {
    const filter = filters[band];
    let power = 0;
    for (let i = filter.start; i < filter.mid; i += 1) {
      power += fftWorkPowers[i] * ((i - filter.start) / filter.riseDivisor);
    }
    for (let i = filter.mid; i < filter.end; i += 1) {
      power += fftWorkPowers[i] * ((filter.end - i) / filter.fallDivisor);
    }
    const logPower = safeLog10(power + 1);
    mel[band] = logPower;
    melTotal += logPower;
  }
  const melMean = melTotal / mel.length;
  for (let i = 0; i < mel.length; i += 1) {
    mel[i] -= melMean;
  }
  return { mel, rmsDb };
}

// lib/intro-postprocess.js
var FRAME_WINDOW_SECONDS = 0.5;
var FRAME_HOP_SECONDS = 0.25;
var BOUNDARY_OUTWARD_SECONDS = 5;
var END_SILENCE_SEARCH_SECONDS = 3;
var END_SILENCE_MIN_SECONDS = 0.75;
var END_SILENCE_POST_SECONDS = 1;
var END_SILENCE_RMS_DB_THRESHOLD = -46;
var END_SILENCE_RECOVERY_DB = 6;
var POST_END_AUDIO_GATE_SECONDS = 1;
var POST_END_SHARED_SIMILARITY_MAX = 0.35;
var POST_END_SHARED_SIMILARITY_DROP = 0.15;
var POST_END_ACTIVITY_MAX = 0.05;
var FADE_BRIDGE_SECONDS = 1.5;
var FADE_INITIAL_WINDOW_SECONDS = 0.5;
var FADE_QUIET_WINDOW_SECONDS = 0.5;
var FADE_SHAPE_WINDOW_SECONDS = 1;
var FADE_INITIAL_RMS_DB_MAX = -70;
var FADE_QUIET_RMS_DB_MAX = -80;
var FADE_SHAPE_INITIAL_RMS_DB_MAX = -56;
var FADE_SHAPE_DROP_DB_MIN = 12;
var FADE_SHAPE_REBOUND_DB_MAX = 2.5;
var FADE_TAIL_CONFIRM_SECONDS = 0.5;
var VIDEO_PROFILE_SECONDS = 5.5;
var VIDEO_PROFILE_LOOKAHEAD_SECONDS = 5;
var VIDEO_PROFILE_FPS = 6;
var VIDEO_PROFILE_WIDTH = 160;
var VIDEO_PROFILE_SCDET_THRESHOLD = 10;
var VIDEO_HOLD_START_SECONDS = 0.5;
var VIDEO_HOLD_MIN_SECONDS = 0.75;
var VIDEO_HOLD_MAFD_MAX = 0.5;
var VIDEO_HOLD_SCORE_MAX = 2;
var AUDIO_WAKE_WINDOW_SECONDS = 0.5;
var AUDIO_WAKE_BASELINE_SECONDS = 0.75;
var AUDIO_WAKE_RMS_DB_THRESHOLD = -40;
var AUDIO_WAKE_ACTIVITY_MAX = 0.12;
var AUDIO_WAKE_RELATIVE_BASELINE_RMS_DB_MAX = -54;
var AUDIO_WAKE_RELATIVE_CURRENT_RMS_DB_MIN = -50;
var AUDIO_WAKE_RISE_DB_MIN = 6;
var FADE_CUT_INITIAL_WINDOW_SECONDS = 0.5;
var FADE_CUT_FINAL_WINDOW_SECONDS = 0.5;
var FADE_CUT_MIN_SECONDS = 1.5;
var FADE_CUT_INITIAL_RMS_DB_MAX = -50;
var FADE_CUT_FINAL_RMS_DB_MAX = -56;
var FADE_CUT_DROP_DB_MIN = 4;
var FADE_CUT_REBOUND_DB_MAX = 2.5;
var FADE_CUT_PRE_WAKE_GRACE_SECONDS = 0.5;
var FADE_CUT_WAKE_WINDOW_SECONDS = 0.5;
var FADE_CUT_WAKE_PEAK_RMS_DB_MIN = -42;
var FADE_CUT_WAKE_RISE_DB_MIN = 8;
var FADE_CUT_WAKE_ACTIVITY_RISE_MIN = 0.08;
var END_SCENE_SNAP_SEARCH_SECONDS = 0.5;
var END_SCENE_SNAP_PROFILE_MARGIN_SECONDS = 0.25;
var END_SCENE_SNAP_SCORE_MIN = VIDEO_PROFILE_SCDET_THRESHOLD;
var END_SCENE_SNAP_QUIET_RMS_DB_MAX = END_SILENCE_RMS_DB_THRESHOLD + 4;
var END_SCENE_SNAP_ACTIVITY_MAX = 0.08;
var END_SCENE_SNAP_BACKWARD_SCORE_MIN = 12;
var END_SCENE_SNAP_SHARED_SIMILARITY_DROP = 0.08;
var START_SCENE_SNAP_SEARCH_SECONDS = 2.5;
var START_SCENE_SNAP_PROFILE_MARGIN_SECONDS = 0.25;
var START_SCENE_SNAP_SCORE_MIN = VIDEO_PROFILE_SCDET_THRESHOLD + 1;
var START_SCENE_SNAP_MIN_FORWARD_SECONDS = 0.35;
var START_SCENE_SNAP_SHORT_POST_SECONDS = 1;
var START_SCENE_SNAP_PLATEAU_DELAY_SECONDS = 0.5;
var START_SCENE_SNAP_PLATEAU_SECONDS = 2;
var START_SCENE_SNAP_SHORT_SIMILARITY_MIN = 0.74;
var START_SCENE_SNAP_PLATEAU_SIMILARITY_MIN = 0.86;
var START_SCENE_SNAP_PLATEAU_GAIN_MIN = 0.16;
var START_SCENE_SNAP_BOUNDARY_TOLERANCE = 0.28;
var SCDET_FRAME_PATTERN = /^frame:\s*(\d+)\s+pts:\s*\S+\s+pts_time:(\S+)/;
var SCDET_MAFD_PATTERN = /^lavfi\.scd\.mafd=(\S+)/;
var SCDET_SCORE_PATTERN = /^lavfi\.scd\.score=(\S+)/;
function frameToSeconds(frame) {
  return round4(frame * FRAME_HOP_SECONDS);
}
function secondToFrameAtOrAfter(seconds) {
  return Math.max(0, Math.ceil(seconds / FRAME_HOP_SECONDS - 1e-6));
}
function getFrameWindowForSecondSpan(startSeconds, endSeconds, frameCount) {
  if (endSeconds <= startSeconds + 1e-6) {
    return null;
  }
  const startFrame = clamp(Math.floor(startSeconds / FRAME_HOP_SECONDS + 1e-6), 0, frameCount);
  let endFrame = clamp(Math.ceil(endSeconds / FRAME_HOP_SECONDS - 1e-6), 0, frameCount);
  if (endFrame <= startFrame) {
    endFrame = Math.min(frameCount, startFrame + 1);
  }
  if (endFrame <= startFrame) {
    return null;
  }
  return {
    startFrame,
    endFrame
  };
}
function formatSecondRange(startSeconds, endSeconds) {
  const normalizedStartSeconds = round4(startSeconds);
  const normalizedEndSeconds = round4(endSeconds);
  return {
    start_seconds: normalizedStartSeconds,
    end_seconds: normalizedEndSeconds,
    duration_seconds: round4(normalizedEndSeconds - normalizedStartSeconds),
    start_hms: secondsToHms(normalizedStartSeconds),
    end_hms: secondsToHms(normalizedEndSeconds)
  };
}
function parseScdetFrames(text) {
  if (!text) {
    return [];
  }
  const frames = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const frameMatch = line.match(SCDET_FRAME_PATTERN);
    if (frameMatch) {
      current = {
        index: Number.parseInt(frameMatch[1], 10),
        ptsTime: Number.parseFloat(frameMatch[2]),
        mafd: null,
        score: null
      };
      frames.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    const mafdMatch = line.match(SCDET_MAFD_PATTERN);
    if (mafdMatch) {
      current.mafd = Number.parseFloat(mafdMatch[1]);
      continue;
    }
    const scoreMatch = line.match(SCDET_SCORE_PATTERN);
    if (scoreMatch) {
      current.score = Number.parseFloat(scoreMatch[1]);
    }
  }
  return frames.filter(
    (frame) => Number.isFinite(frame.ptsTime) && Number.isFinite(frame.mafd) && Number.isFinite(frame.score)
  );
}
function detectSilentStaticHoldBoundary(frames, holdStartSeconds = 0) {
  if (!frames.length) {
    return null;
  }
  const holdFrames = frames.filter((frame) => frame.ptsTime >= holdStartSeconds - 1e-6);
  if (!holdFrames.length) {
    return null;
  }
  const initialFrames = holdFrames.filter(
    (frame) => frame.ptsTime < holdStartSeconds + VIDEO_HOLD_START_SECONDS + 1e-6
  );
  if (!initialFrames.length) {
    return null;
  }
  if (mean(initialFrames.map((frame) => frame.mafd)) > VIDEO_HOLD_MAFD_MAX || Math.max(...initialFrames.map((frame) => frame.score)) >= VIDEO_HOLD_SCORE_MAX) {
    return null;
  }
  let holdEndIndex = -1;
  let holdEndTime = null;
  for (let index = 0; index < holdFrames.length; index += 1) {
    const frame = holdFrames[index];
    if (frame.ptsTime > VIDEO_PROFILE_LOOKAHEAD_SECONDS + 1e-6) {
      break;
    }
    if (frame.mafd > VIDEO_HOLD_MAFD_MAX || frame.score >= VIDEO_HOLD_SCORE_MAX) {
      break;
    }
    holdEndIndex = index;
    holdEndTime = frame.ptsTime;
  }
  if (holdEndIndex < 0 || holdEndTime === null || holdEndTime - holdStartSeconds + 1e-6 < VIDEO_HOLD_MIN_SECONDS) {
    return null;
  }
  for (let index = holdEndIndex + 1; index < holdFrames.length - 1; index += 1) {
    const current = holdFrames[index];
    if (current.ptsTime > VIDEO_PROFILE_LOOKAHEAD_SECONDS + 1e-6) {
      break;
    }
    const previous = holdFrames[index - 1];
    const next = holdFrames[index + 1];
    if (current.score >= VIDEO_PROFILE_SCDET_THRESHOLD && current.score >= previous.score && current.score >= next.score) {
      return current;
    }
  }
  return null;
}
function hasStillTailBeforeBoundary(frames, boundary, holdStartSeconds = 0) {
  const tailStart = Math.max(holdStartSeconds, boundary.ptsTime - FADE_TAIL_CONFIRM_SECONDS);
  const tailFrames = frames.filter(
    (frame) => frame.ptsTime >= tailStart - 1e-6 && frame.ptsTime < boundary.ptsTime - 1e-6
  );
  if (!tailFrames.length) {
    return false;
  }
  return mean(tailFrames.map((frame) => frame.mafd)) <= VIDEO_HOLD_MAFD_MAX && Math.max(...tailFrames.map((frame) => frame.score)) < VIDEO_HOLD_SCORE_MAX;
}
function audioWindowMetrics(mainEpisode, startFrame, endFrame) {
  return {
    rms: rangeMean(mainEpisode.prefixRms, startFrame, endFrame),
    activity: mainEpisode.getMeanMelFrameDelta(startFrame, endFrame)
  };
}
function collectRmsFramesBeforeTime(mainEpisode, startFrame, boundaryTimeSeconds, minFrameEndSeconds = Number.NEGATIVE_INFINITY) {
  const tailFrames = [];
  for (let frame = startFrame; frame < mainEpisode.rmsDb.length; frame += 1) {
    const frameStart = frame * FRAME_HOP_SECONDS;
    const frameEnd = frameStart + FRAME_WINDOW_SECONDS;
    if (frameEnd > boundaryTimeSeconds + 1e-6) {
      break;
    }
    if (frameEnd <= minFrameEndSeconds + 1e-6) {
      continue;
    }
    tailFrames.push(mainEpisode.rmsDb[frame]);
  }
  return tailFrames;
}
function maxStepRise(values) {
  let maxRise = 0;
  for (let index = 1; index < values.length; index += 1) {
    maxRise = Math.max(maxRise, values[index] - values[index - 1]);
  }
  return maxRise;
}
function findFadeToQuietHoldStartFrame(mainEpisode, startFrame) {
  const bridgeFrames = Math.max(2, Math.round(FADE_BRIDGE_SECONDS / FRAME_HOP_SECONDS));
  const initialWindowFrames = Math.max(
    2,
    Math.round(FADE_INITIAL_WINDOW_SECONDS / FRAME_HOP_SECONDS)
  );
  const shapeWindowFrames = Math.max(3, Math.round(FADE_SHAPE_WINDOW_SECONDS / FRAME_HOP_SECONDS));
  const quietWindowFrames = Math.max(2, Math.round(FADE_QUIET_WINDOW_SECONDS / FRAME_HOP_SECONDS));
  const bridgeEnd = Math.min(mainEpisode.rmsDb.length, startFrame + bridgeFrames);
  if (bridgeEnd - startFrame < quietWindowFrames) {
    return null;
  }
  const initialEnd = Math.min(bridgeEnd, startFrame + initialWindowFrames);
  const initialRms = rangeMean(mainEpisode.prefixRms, startFrame, initialEnd);
  const maxQuietStart = bridgeEnd - quietWindowFrames;
  let quietStartFrame = null;
  for (let frame = startFrame; frame <= maxQuietStart; frame += 1) {
    const quietRms = rangeMean(mainEpisode.prefixRms, frame, frame + quietWindowFrames);
    if (quietRms <= FADE_QUIET_RMS_DB_MAX) {
      quietStartFrame = frame;
      break;
    }
  }
  if (quietStartFrame === null) {
    return null;
  }
  if (initialRms <= FADE_INITIAL_RMS_DB_MAX) {
    return quietStartFrame;
  }
  if (initialRms > FADE_SHAPE_INITIAL_RMS_DB_MAX) {
    return null;
  }
  const shapeEnd = Math.min(bridgeEnd, startFrame + shapeWindowFrames);
  const shapeSamples = [];
  for (let frame = startFrame; frame < shapeEnd; frame += 1) {
    shapeSamples.push(mainEpisode.rmsDb[frame]);
  }
  if (shapeSamples.length < 3) {
    return null;
  }
  const minShapeRms = Math.min(...shapeSamples);
  if (initialRms - minShapeRms < FADE_SHAPE_DROP_DB_MIN) {
    return null;
  }
  if (maxStepRise(shapeSamples) > FADE_SHAPE_REBOUND_DB_MAX) {
    return null;
  }
  return quietStartFrame;
}
function audioWakesBeforeBoundary(mainEpisode, startFrame, endFrame, ignoreTrailingFrames = 0) {
  const windowFrames = Math.max(2, Math.round(AUDIO_WAKE_WINDOW_SECONDS / FRAME_HOP_SECONDS));
  const baselineFrames = Math.max(2, Math.round(AUDIO_WAKE_BASELINE_SECONDS / FRAME_HOP_SECONDS));
  const effectiveEndFrame = Math.max(startFrame, endFrame - Math.max(0, ignoreTrailingFrames));
  if (effectiveEndFrame - startFrame < windowFrames) {
    return false;
  }
  for (let frame = startFrame; frame + windowFrames < effectiveEndFrame; frame += 1) {
    const { rms, activity } = audioWindowMetrics(mainEpisode, frame, frame + windowFrames);
    const baselineStart = Math.max(startFrame, frame - baselineFrames);
    const baselineSpan = frame - baselineStart;
    const baselineRms = frame > baselineStart ? rangeMean(mainEpisode.prefixRms, baselineStart, frame) : null;
    if (rms > AUDIO_WAKE_RMS_DB_THRESHOLD || rms > END_SILENCE_RMS_DB_THRESHOLD && activity > AUDIO_WAKE_ACTIVITY_MAX || baselineRms !== null && baselineSpan >= baselineFrames && baselineRms <= AUDIO_WAKE_RELATIVE_BASELINE_RMS_DB_MAX && rms >= AUDIO_WAKE_RELATIVE_CURRENT_RMS_DB_MIN && rms - baselineRms >= AUDIO_WAKE_RISE_DB_MIN) {
      return true;
    }
  }
  return false;
}
function hasQuietTailBeforeBoundary(mainEpisode, boundaryTimeSeconds, holdStartFrame = 0) {
  const tailFrames = collectRmsFramesBeforeTime(
    mainEpisode,
    holdStartFrame,
    boundaryTimeSeconds,
    boundaryTimeSeconds - FADE_TAIL_CONFIRM_SECONDS
  );
  if (!tailFrames.length) {
    return false;
  }
  return mean(tailFrames) <= FADE_QUIET_RMS_DB_MAX;
}
function getPostEndAudioExtensionState(mainEpisode, startFrame, endFrame) {
  const { rms: postRms, activity: postActivity } = audioWindowMetrics(
    mainEpisode,
    startFrame,
    endFrame
  );
  const fadeHoldStartFrame = findFadeToQuietHoldStartFrame(mainEpisode, startFrame);
  const fadeCutWindowFrames = Math.max(
    2,
    Math.round(FADE_CUT_INITIAL_WINDOW_SECONDS / FRAME_HOP_SECONDS)
  );
  const fadeCutInitialEnd = Math.min(mainEpisode.rmsDb.length, startFrame + fadeCutWindowFrames);
  const fadeCutInitialRms = fadeCutInitialEnd - startFrame >= fadeCutWindowFrames ? rangeMean(mainEpisode.prefixRms, startFrame, fadeCutInitialEnd) : Number.POSITIVE_INFINITY;
  const canTrySilentStaticHold = postRms <= END_SILENCE_RMS_DB_THRESHOLD && postActivity <= POST_END_ACTIVITY_MAX || fadeHoldStartFrame !== null;
  const canTryFadeCutHold = fadeHoldStartFrame === null && fadeCutInitialRms <= FADE_CUT_INITIAL_RMS_DB_MAX;
  return {
    postRms,
    postActivity,
    fadeHoldStartFrame,
    canTrySilentStaticHold,
    canTryFadeCutHold
  };
}
function withEpisodeMetrics(mainEpisode) {
  return {
    ...mainEpisode,
    getMeanMelFrameDelta: mainEpisode.getMeanMelFrameDelta ?? (() => 0)
  };
}
async function getPostEndStaticBoundaryContext({
  sharedAudio,
  mainEpisode,
  pairwiseRuns,
  mainFile,
  runCommand,
  maxLen,
  getMeanDiagonalSimilarityForRefs
}) {
  const episode = withEpisodeMetrics(mainEpisode);
  const gateFrames = Math.max(2, Math.round(POST_END_AUDIO_GATE_SECONDS / FRAME_HOP_SECONDS));
  const startFrame = sharedAudio.mainEnd;
  const endFrame = Math.min(episode.rmsDb.length, startFrame + gateFrames);
  if (endFrame - startFrame < gateFrames) {
    return null;
  }
  const preStart = Math.max(0, startFrame - gateFrames);
  const postSharedSimilarity = getMeanDiagonalSimilarityForRefs(
    sharedAudio,
    pairwiseRuns,
    startFrame,
    endFrame
  );
  const preSharedSimilarity = getMeanDiagonalSimilarityForRefs(
    sharedAudio,
    pairwiseRuns,
    preStart,
    startFrame
  );
  if (postSharedSimilarity === null || preSharedSimilarity === null || postSharedSimilarity > POST_END_SHARED_SIMILARITY_MAX || postSharedSimilarity > preSharedSimilarity - POST_END_SHARED_SIMILARITY_DROP) {
    return null;
  }
  const audioState = getPostEndAudioExtensionState(episode, startFrame, endFrame);
  if (!audioState.canTrySilentStaticHold && !audioState.canTryFadeCutHold) {
    return null;
  }
  const frames = await extractVideoSceneProfile(
    mainFile,
    sharedAudio.mainEnd * FRAME_HOP_SECONDS,
    VIDEO_PROFILE_SECONDS,
    runCommand
  );
  if (!frames?.length) {
    return null;
  }
  const boundary = detectSilentStaticHoldBoundary(frames, 0);
  if (!boundary) {
    return null;
  }
  const boundaryTimeSeconds = sharedAudio.mainEnd * FRAME_HOP_SECONDS + boundary.ptsTime;
  const boundaryFrame = secondToFrameAtOrAfter(boundaryTimeSeconds);
  const clampedEndSeconds = Math.min(
    frameToSeconds(sharedAudio.mainStart + maxLen),
    boundaryTimeSeconds
  );
  const clampedEndFrame = secondToFrameAtOrAfter(clampedEndSeconds);
  if (clampedEndSeconds <= frameToSeconds(sharedAudio.mainEnd) + 1e-6) {
    return null;
  }
  return {
    startFrame,
    ...audioState,
    frames,
    boundary,
    boundaryTimeSeconds,
    boundaryFrame,
    clampedEndFrame,
    clampedEndSeconds
  };
}
function hasFadingTailBeforeBoundary(mainEpisode, startFrame, boundaryTimeSeconds) {
  const episode = withEpisodeMetrics(mainEpisode);
  const minFrames = Math.max(4, Math.round(FADE_CUT_MIN_SECONDS / FRAME_HOP_SECONDS));
  const initialWindowFrames = Math.max(
    2,
    Math.round(FADE_CUT_INITIAL_WINDOW_SECONDS / FRAME_HOP_SECONDS)
  );
  const finalWindowFrames = Math.max(
    2,
    Math.round(FADE_CUT_FINAL_WINDOW_SECONDS / FRAME_HOP_SECONDS)
  );
  const tailFrames = collectRmsFramesBeforeTime(episode, startFrame, boundaryTimeSeconds);
  if (tailFrames.length < Math.max(minFrames, initialWindowFrames + finalWindowFrames)) {
    return false;
  }
  const initialRms = mean(tailFrames.slice(0, initialWindowFrames));
  const finalRms = mean(tailFrames.slice(-finalWindowFrames));
  if (initialRms > FADE_CUT_INITIAL_RMS_DB_MAX || finalRms > FADE_CUT_FINAL_RMS_DB_MAX) {
    return false;
  }
  if (initialRms - finalRms < FADE_CUT_DROP_DB_MIN) {
    return false;
  }
  return maxStepRise(tailFrames) <= FADE_CUT_REBOUND_DB_MAX;
}
function hasBoundaryAudioWake(mainEpisode, boundaryFrame) {
  const episode = withEpisodeMetrics(mainEpisode);
  const windowFrames = Math.max(2, Math.round(FADE_CUT_WAKE_WINDOW_SECONDS / FRAME_HOP_SECONDS));
  const preStart = Math.max(0, boundaryFrame - windowFrames);
  const postEnd = Math.min(episode.rmsDb.length, boundaryFrame + windowFrames);
  if (boundaryFrame <= preStart || postEnd <= boundaryFrame) {
    return false;
  }
  const { rms: preRms, activity: preActivity } = audioWindowMetrics(episode, preStart, boundaryFrame);
  const { rms: postRms, activity: postActivity } = audioWindowMetrics(episode, boundaryFrame, postEnd);
  let postPeakRms = Number.NEGATIVE_INFINITY;
  for (let frame = boundaryFrame; frame < postEnd; frame += 1) {
    postPeakRms = Math.max(postPeakRms, episode.rmsDb[frame]);
  }
  return postPeakRms >= FADE_CUT_WAKE_PEAK_RMS_DB_MIN || postRms - preRms >= FADE_CUT_WAKE_RISE_DB_MIN || postActivity - preActivity >= FADE_CUT_WAKE_ACTIVITY_RISE_MIN;
}
function isSceneChangePeak(frames, index) {
  const frame = frames[index];
  if (!frame || frame.score < END_SCENE_SNAP_SCORE_MIN) {
    return false;
  }
  const previous = frames[index - 1];
  const next = frames[index + 1];
  return (!previous || frame.score >= previous.score) && (!next || frame.score >= next.score);
}
function collectNearbySceneChangeCandidates(frames, profileStartSeconds, anchorTimeSeconds, searchSeconds = END_SCENE_SNAP_SEARCH_SECONDS) {
  const candidates = [];
  for (let index = 0; index < frames.length; index += 1) {
    if (!isSceneChangePeak(frames, index)) {
      continue;
    }
    const absoluteTimeSeconds = profileStartSeconds + frames[index].ptsTime;
    const distanceSeconds = absoluteTimeSeconds - anchorTimeSeconds;
    if (Math.abs(distanceSeconds) > searchSeconds + 1e-6) {
      continue;
    }
    candidates.push({
      frame: frames[index],
      timeSeconds: absoluteTimeSeconds,
      distanceSeconds,
      distanceAbs: Math.abs(distanceSeconds)
    });
  }
  candidates.sort(
    (a, b) => lexicographicDescending(
      [-a.distanceAbs, a.distanceSeconds <= 0 ? 1 : 0, a.frame.score, -a.timeSeconds],
      [-b.distanceAbs, b.distanceSeconds <= 0 ? 1 : 0, b.frame.score, -b.timeSeconds]
    )
  );
  return candidates;
}
function hasNearbySceneSnapQuietGap(mainEpisode, startSeconds, endSeconds) {
  const frameWindow = getFrameWindowForSecondSpan(
    startSeconds,
    endSeconds,
    mainEpisode.rmsDb.length
  );
  if (!frameWindow) {
    return false;
  }
  const { startFrame, endFrame } = frameWindow;
  const gapRms = rangeMean(mainEpisode.prefixRms, startFrame, endFrame);
  const gapActivity = mainEpisode.getMeanMelFrameDelta(startFrame, endFrame);
  if (gapRms > END_SCENE_SNAP_QUIET_RMS_DB_MAX || gapActivity > END_SCENE_SNAP_ACTIVITY_MAX) {
    return false;
  }
  return true;
}
function hasNearbySceneSnapSharedDrop(sharedAudio, mainEpisode, pairwiseRuns, startSeconds, endSeconds, getMeanDiagonalSimilarityForRefs) {
  const gapWindow = getFrameWindowForSecondSpan(
    startSeconds,
    endSeconds,
    mainEpisode.frames.length
  );
  if (!gapWindow) {
    return false;
  }
  const { startFrame, endFrame } = gapWindow;
  const gapSimilarity = getMeanDiagonalSimilarityForRefs(
    sharedAudio,
    pairwiseRuns,
    startFrame,
    endFrame
  );
  if (gapSimilarity === null || gapSimilarity > POST_END_SHARED_SIMILARITY_MAX) {
    return false;
  }
  const baselineDurationSeconds = endSeconds - startSeconds;
  const baselineStartSeconds = Math.max(
    frameToSeconds(sharedAudio.mainStart),
    startSeconds - baselineDurationSeconds
  );
  const baselineWindow = getFrameWindowForSecondSpan(
    baselineStartSeconds,
    startSeconds,
    mainEpisode.frames.length
  );
  const baselineSimilarity = baselineWindow ? getMeanDiagonalSimilarityForRefs(
    sharedAudio,
    pairwiseRuns,
    baselineWindow.startFrame,
    baselineWindow.endFrame
  ) : null;
  return baselineSimilarity === null || gapSimilarity <= baselineSimilarity - END_SCENE_SNAP_SHARED_SIMILARITY_DROP;
}
function collectPotentialSceneProfileTimes(profileStartSeconds, durationSeconds, fps) {
  const times = [];
  const maxIndex = Math.max(0, Math.ceil(durationSeconds * fps + 1e-6));
  for (let index = 0; index <= maxIndex; index += 1) {
    times.push(profileStartSeconds + index / fps);
  }
  return times;
}
async function extractVideoSceneProfile(path, startSeconds, durationSeconds, runCommand) {
  let result;
  try {
    result = await runCommand({
      command: "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        String(startSeconds),
        "-t",
        String(durationSeconds),
        "-i",
        path,
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-dn",
        "-vf",
        `fps=${VIDEO_PROFILE_FPS},scale=${VIDEO_PROFILE_WIDTH}:-2:flags=fast_bilinear,format=gray,scdet=threshold=${VIDEO_PROFILE_SCDET_THRESHOLD},metadata=mode=print:file=-`,
        "-f",
        "null",
        "-"
      ],
      stdoutMode: "text"
    });
  } catch {
    return null;
  }
  if (result.code !== 0) {
    return null;
  }
  const frames = parseScdetFrames(result.stdout);
  return frames.length ? frames : null;
}
function setIntroEndSeconds(intro, endSeconds) {
  const normalizedEndSeconds = round4(endSeconds);
  return {
    ...intro,
    mainEnd: secondToFrameAtOrAfter(normalizedEndSeconds),
    endSeconds: normalizedEndSeconds,
    durationSeconds: round4(normalizedEndSeconds - intro.startSeconds)
  };
}
function setIntroStartSeconds(intro, startSeconds) {
  const normalizedStartSeconds = round4(startSeconds);
  return {
    ...intro,
    mainStart: secondToFrameAtOrAfter(normalizedStartSeconds),
    startSeconds: normalizedStartSeconds,
    durationSeconds: round4(intro.endSeconds - normalizedStartSeconds)
  };
}
function maybeExtendIntroToStaticBoundary({
  intro,
  sharedAudio,
  mainEpisode,
  boundaryContext,
  ignoreTrailingFrames = 0,
  requireBoundaryWake = false
}) {
  if (!boundaryContext) {
    return intro;
  }
  const episode = withEpisodeMetrics(mainEpisode);
  const { frames, boundary, boundaryFrame, clampedEndFrame, clampedEndSeconds } = boundaryContext;
  if (!hasStillTailBeforeBoundary(frames, boundary, 0)) {
    return intro;
  }
  if (audioWakesBeforeBoundary(
    episode,
    sharedAudio.mainEnd,
    clampedEndFrame,
    ignoreTrailingFrames
  )) {
    return intro;
  }
  if (requireBoundaryWake && !hasBoundaryAudioWake(episode, boundaryFrame)) {
    return intro;
  }
  return setIntroEndSeconds(intro, clampedEndSeconds);
}
function extendIntroEndAtSilentStaticHold({
  intro,
  sharedAudio,
  mainEpisode,
  boundaryContext
}) {
  if (!boundaryContext) {
    return intro;
  }
  const episode = withEpisodeMetrics(mainEpisode);
  const {
    postRms,
    postActivity,
    boundaryTimeSeconds,
    fadeHoldStartFrame,
    canTrySilentStaticHold
  } = boundaryContext;
  if (!canTrySilentStaticHold) {
    return intro;
  }
  if (postRms > END_SILENCE_RMS_DB_THRESHOLD || postActivity > POST_END_ACTIVITY_MAX) {
    if (fadeHoldStartFrame === null || !hasQuietTailBeforeBoundary(episode, boundaryTimeSeconds, fadeHoldStartFrame)) {
      return intro;
    }
  }
  return maybeExtendIntroToStaticBoundary({ intro, sharedAudio, mainEpisode: episode, boundaryContext });
}
function extendIntroEndAtFadeCutHold({ intro, sharedAudio, mainEpisode, boundaryContext }) {
  if (!boundaryContext) {
    return intro;
  }
  const episode = withEpisodeMetrics(mainEpisode);
  const { startFrame, boundaryTimeSeconds, canTryFadeCutHold } = boundaryContext;
  if (!canTryFadeCutHold || !hasFadingTailBeforeBoundary(episode, startFrame, boundaryTimeSeconds)) {
    return intro;
  }
  return maybeExtendIntroToStaticBoundary({
    intro,
    sharedAudio,
    mainEpisode: episode,
    boundaryContext,
    ignoreTrailingFrames: Math.max(
      2,
      Math.round(FADE_CUT_PRE_WAKE_GRACE_SECONDS / FRAME_HOP_SECONDS)
    ),
    requireBoundaryWake: true
  });
}
async function snapIntroEndToNearbySceneChange({
  intro,
  sharedAudio,
  mainEpisode,
  pairwiseRuns,
  minLen,
  maxLen,
  mainFile,
  runCommand,
  getMeanDiagonalSimilarityForRefs
}) {
  const episode = withEpisodeMetrics(mainEpisode);
  const anchorTimeSeconds = intro.endSeconds;
  const canExtendForwardFromSharedEnd = Math.abs(intro.endSeconds - frameToSeconds(sharedAudio.mainEnd)) <= 1e-6;
  const minEndSeconds = intro.startSeconds + minLen * FRAME_HOP_SECONDS;
  const maxEndSeconds = intro.startSeconds + maxLen * FRAME_HOP_SECONDS;
  const profileStartSeconds = Math.max(
    0,
    anchorTimeSeconds - END_SCENE_SNAP_SEARCH_SECONDS - END_SCENE_SNAP_PROFILE_MARGIN_SECONDS
  );
  const profileDurationSeconds = END_SCENE_SNAP_SEARCH_SECONDS * 2 + END_SCENE_SNAP_PROFILE_MARGIN_SECONDS * 2;
  const potentialTimes = collectPotentialSceneProfileTimes(
    profileStartSeconds,
    profileDurationSeconds,
    VIDEO_PROFILE_FPS
  );
  const hasBackwardWindow = potentialTimes.some(
    (timeSeconds) => timeSeconds >= minEndSeconds - 1e-6 && timeSeconds < anchorTimeSeconds - 1e-6 && anchorTimeSeconds - timeSeconds <= END_SCENE_SNAP_SEARCH_SECONDS + 1e-6
  );
  const hasForwardAudioCandidate = canExtendForwardFromSharedEnd && potentialTimes.some((timeSeconds) => {
    if (timeSeconds <= anchorTimeSeconds + 1e-6 || timeSeconds > maxEndSeconds + 1e-6 || timeSeconds - anchorTimeSeconds > END_SCENE_SNAP_SEARCH_SECONDS + 1e-6) {
      return false;
    }
    const boundaryFrame = secondToFrameAtOrAfter(timeSeconds);
    return hasNearbySceneSnapQuietGap(episode, intro.endSeconds, timeSeconds) && hasNearbySceneSnapSharedDrop(
      sharedAudio,
      episode,
      pairwiseRuns,
      intro.endSeconds,
      timeSeconds,
      getMeanDiagonalSimilarityForRefs
    ) && !audioWakesBeforeBoundary(episode, intro.mainEnd, boundaryFrame);
  });
  if (!hasBackwardWindow && !hasForwardAudioCandidate) {
    return intro;
  }
  const frames = await extractVideoSceneProfile(
    mainFile,
    profileStartSeconds,
    profileDurationSeconds,
    runCommand
  );
  if (!frames?.length) {
    return intro;
  }
  const candidates = collectNearbySceneChangeCandidates(
    frames,
    profileStartSeconds,
    anchorTimeSeconds
  );
  if (!candidates.length) {
    return intro;
  }
  for (const candidate of candidates) {
    const boundaryFrame = secondToFrameAtOrAfter(candidate.timeSeconds);
    if (Math.abs(candidate.timeSeconds - intro.endSeconds) <= 1e-6 || candidate.timeSeconds < minEndSeconds - 1e-6 || candidate.timeSeconds > maxEndSeconds + 1e-6) {
      continue;
    }
    if (candidate.distanceSeconds < 0) {
      if (candidate.frame.score >= END_SCENE_SNAP_BACKWARD_SCORE_MIN) {
        return setIntroEndSeconds(intro, candidate.timeSeconds);
      }
      continue;
    }
    if (canExtendForwardFromSharedEnd && hasNearbySceneSnapQuietGap(episode, intro.endSeconds, candidate.timeSeconds) && hasNearbySceneSnapSharedDrop(
      sharedAudio,
      episode,
      pairwiseRuns,
      intro.endSeconds,
      candidate.timeSeconds,
      getMeanDiagonalSimilarityForRefs
    ) && !audioWakesBeforeBoundary(episode, intro.mainEnd, boundaryFrame)) {
      return setIntroEndSeconds(intro, candidate.timeSeconds);
    }
  }
  return intro;
}
function hasBleedSceneChangeSharedPlateau(sharedAudio, mainEpisode, pairwiseRuns, startSeconds, endSeconds, getMeanDiagonalSimilarityForRefs) {
  const shortPostWindow = getFrameWindowForSecondSpan(
    startSeconds,
    startSeconds + START_SCENE_SNAP_SHORT_POST_SECONDS,
    mainEpisode.frames.length
  );
  const plateauWindow = getFrameWindowForSecondSpan(
    startSeconds + START_SCENE_SNAP_PLATEAU_DELAY_SECONDS,
    startSeconds + START_SCENE_SNAP_PLATEAU_DELAY_SECONDS + START_SCENE_SNAP_PLATEAU_SECONDS,
    mainEpisode.frames.length
  );
  const prefixWindow = getFrameWindowForSecondSpan(
    endSeconds,
    startSeconds,
    mainEpisode.frames.length
  );
  if (!shortPostWindow || !plateauWindow || !prefixWindow) {
    return false;
  }
  const shortPostSimilarity = getMeanDiagonalSimilarityForRefs(
    sharedAudio,
    pairwiseRuns,
    shortPostWindow.startFrame,
    shortPostWindow.endFrame
  );
  const plateauSimilarity = getMeanDiagonalSimilarityForRefs(
    sharedAudio,
    pairwiseRuns,
    plateauWindow.startFrame,
    plateauWindow.endFrame
  );
  const prefixSimilarity = getMeanDiagonalSimilarityForRefs(
    sharedAudio,
    pairwiseRuns,
    prefixWindow.startFrame,
    prefixWindow.endFrame
  );
  if (shortPostSimilarity === null || plateauSimilarity === null || prefixSimilarity === null || shortPostSimilarity < START_SCENE_SNAP_SHORT_SIMILARITY_MIN || plateauSimilarity < START_SCENE_SNAP_PLATEAU_SIMILARITY_MIN) {
    return false;
  }
  return plateauSimilarity >= prefixSimilarity + START_SCENE_SNAP_PLATEAU_GAIN_MIN;
}
function collectBleedSceneChangeAudioCandidates({
  intro,
  sharedAudio,
  mainEpisode,
  pairwiseRuns,
  minLen,
  getMeanDiagonalSimilarityForRefs,
  getSharedAudioBoundaryScore
}) {
  const audioCandidates = /* @__PURE__ */ new Map();
  const minStartFrame = secondToFrameAtOrAfter(
    intro.startSeconds + START_SCENE_SNAP_MIN_FORWARD_SECONDS
  );
  const maxStartFrame = Math.min(
    secondToFrameAtOrAfter(intro.startSeconds + START_SCENE_SNAP_SEARCH_SECONDS),
    intro.mainEnd - minLen
  );
  if (maxStartFrame < minStartFrame) {
    return audioCandidates;
  }
  const baseBoundary = getSharedAudioBoundaryScore(
    sharedAudio,
    pairwiseRuns,
    sharedAudio.mainStart,
    sharedAudio.mainEnd,
    "start"
  )?.score ?? Number.NEGATIVE_INFINITY;
  for (let candidateFrame = minStartFrame; candidateFrame <= maxStartFrame; candidateFrame += 1) {
    const candidateSeconds = frameToSeconds(candidateFrame);
    if (!hasBleedSceneChangeSharedPlateau(
      sharedAudio,
      mainEpisode,
      pairwiseRuns,
      candidateSeconds,
      intro.startSeconds,
      getMeanDiagonalSimilarityForRefs
    )) {
      continue;
    }
    const candidateBoundary = getSharedAudioBoundaryScore(
      sharedAudio,
      pairwiseRuns,
      candidateFrame,
      sharedAudio.mainEnd,
      "start"
    );
    if (!candidateBoundary || candidateBoundary.score < baseBoundary - START_SCENE_SNAP_BOUNDARY_TOLERANCE) {
      continue;
    }
    audioCandidates.set(candidateFrame, candidateBoundary.score);
  }
  return audioCandidates;
}
async function trimIntroStartAtBleedSceneChange({
  intro,
  sharedAudio,
  mainEpisode,
  pairwiseRuns,
  minLen,
  mainFile,
  runCommand,
  getMeanDiagonalSimilarityForRefs,
  getSharedAudioBoundaryScore
}) {
  const episode = withEpisodeMetrics(mainEpisode);
  const anchorTimeSeconds = intro.startSeconds;
  const audioCandidates = collectBleedSceneChangeAudioCandidates({
    intro,
    sharedAudio,
    mainEpisode: episode,
    pairwiseRuns,
    minLen,
    getMeanDiagonalSimilarityForRefs,
    getSharedAudioBoundaryScore
  });
  if (!audioCandidates.size) {
    return intro;
  }
  const profileStartSeconds = Math.max(
    0,
    anchorTimeSeconds - START_SCENE_SNAP_PROFILE_MARGIN_SECONDS
  );
  const profileDurationSeconds = START_SCENE_SNAP_SEARCH_SECONDS + START_SCENE_SNAP_PROFILE_MARGIN_SECONDS * 2;
  const frames = await extractVideoSceneProfile(
    mainFile,
    profileStartSeconds,
    profileDurationSeconds,
    runCommand
  );
  if (!frames?.length) {
    return intro;
  }
  const candidates = collectNearbySceneChangeCandidates(
    frames,
    profileStartSeconds,
    anchorTimeSeconds,
    START_SCENE_SNAP_SEARCH_SECONDS
  ).filter(
    (candidate) => candidate.distanceSeconds >= START_SCENE_SNAP_MIN_FORWARD_SECONDS - 1e-6 && candidate.distanceSeconds <= START_SCENE_SNAP_SEARCH_SECONDS + 1e-6 && candidate.frame.score >= START_SCENE_SNAP_SCORE_MIN
  ).sort((a, b) => a.timeSeconds - b.timeSeconds);
  if (!candidates.length) {
    return intro;
  }
  for (const candidate of candidates) {
    const candidateFrame = secondToFrameAtOrAfter(candidate.timeSeconds);
    if (!audioCandidates.has(candidateFrame)) {
      continue;
    }
    return setIntroStartSeconds(intro, candidate.timeSeconds);
  }
  return intro;
}
function resolvePreJingleSilenceEnd(prefixRms, rmsDb, runStart, runEnd, minEnd, postFrames) {
  if (runStart < minEnd || runEnd <= runStart) {
    return null;
  }
  const silenceLevel = rangeMean(prefixRms, runStart, runEnd);
  const postEnd = Math.min(rmsDb.length, runEnd + postFrames);
  const postLevel = rangeMean(prefixRms, runEnd, postEnd);
  if (postEnd <= runEnd || postLevel < END_SILENCE_RMS_DB_THRESHOLD + 2 || postLevel - silenceLevel < END_SILENCE_RECOVERY_DB) {
    return null;
  }
  return runEnd;
}
function pickPreJingleSilenceEnd({
  bestEnd,
  prefixRms,
  rmsDb,
  runStart,
  runEnd,
  minSilenceFrames,
  minEnd,
  postFrames
}) {
  if (runEnd - runStart < minSilenceFrames) {
    return bestEnd;
  }
  return resolvePreJingleSilenceEnd(prefixRms, rmsDb, runStart, runEnd, minEnd, postFrames) ?? bestEnd;
}
function trimIntroEndAtPreJingleSilence(intro, mainEpisode, minLen) {
  const { rmsDb } = mainEpisode;
  const { mainStart: start, mainEnd: end } = intro;
  const minEnd = start + minLen;
  if (!rmsDb?.length || end <= minEnd) {
    return intro;
  }
  const searchSeconds = Math.max(END_SILENCE_SEARCH_SECONDS, BOUNDARY_OUTWARD_SECONDS);
  const searchFrames = Math.max(4, Math.round(searchSeconds / FRAME_HOP_SECONDS));
  const minSilenceFrames = Math.max(2, Math.round(END_SILENCE_MIN_SECONDS / FRAME_HOP_SECONDS));
  const postFrames = Math.max(2, Math.round(END_SILENCE_POST_SECONDS / FRAME_HOP_SECONDS));
  const searchStart = Math.max(minEnd, end - searchFrames);
  const searchEnd = Math.min(end, rmsDb.length);
  const prefixRms = mainEpisode.prefixRms ?? prefixSums(rmsDb);
  let bestEnd = end;
  let runStart = -1;
  for (let index = searchStart; index < searchEnd; index += 1) {
    if (rmsDb[index] <= END_SILENCE_RMS_DB_THRESHOLD) {
      if (runStart < 0) {
        runStart = index;
      }
      continue;
    }
    if (runStart >= 0) {
      const runEnd = index;
      bestEnd = pickPreJingleSilenceEnd({
        bestEnd,
        prefixRms,
        rmsDb,
        runStart,
        runEnd,
        minSilenceFrames,
        minEnd,
        postFrames
      });
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    bestEnd = pickPreJingleSilenceEnd({
      bestEnd,
      prefixRms,
      rmsDb,
      runStart,
      runEnd: searchEnd,
      minSilenceFrames,
      minEnd,
      postFrames
    });
  }
  return {
    ...intro,
    mainEnd: bestEnd,
    endSeconds: frameToSeconds(bestEnd),
    durationSeconds: round4(frameToSeconds(bestEnd) - intro.startSeconds)
  };
}
async function postProcessIntroFromSharedAudio({
  sharedAudio,
  mainEpisode,
  pairwiseRuns,
  minLen,
  maxLen,
  mainFile,
  runCommand,
  getMeanDiagonalSimilarityForRefs,
  getSharedAudioBoundaryScore
}) {
  const episode = withEpisodeMetrics(mainEpisode);
  let intro = {
    mainStart: sharedAudio.mainStart,
    mainEnd: sharedAudio.mainEnd,
    startSeconds: frameToSeconds(sharedAudio.mainStart),
    endSeconds: frameToSeconds(sharedAudio.mainEnd),
    durationSeconds: round4((sharedAudio.mainEnd - sharedAudio.mainStart) * FRAME_HOP_SECONDS)
  };
  intro = await trimIntroStartAtBleedSceneChange({
    intro,
    sharedAudio,
    mainEpisode: episode,
    pairwiseRuns,
    minLen,
    mainFile,
    runCommand,
    getMeanDiagonalSimilarityForRefs,
    getSharedAudioBoundaryScore
  });
  intro = trimIntroEndAtPreJingleSilence(intro, episode, minLen);
  const didTrimPreJingleSilence = intro.mainEnd !== sharedAudio.mainEnd;
  const boundaryContext = await getPostEndStaticBoundaryContext({
    sharedAudio,
    mainEpisode: episode,
    pairwiseRuns,
    mainFile,
    runCommand,
    maxLen,
    getMeanDiagonalSimilarityForRefs
  });
  if (!didTrimPreJingleSilence) {
    intro = extendIntroEndAtSilentStaticHold({
      intro,
      sharedAudio,
      mainEpisode: episode,
      boundaryContext
    });
    intro = extendIntroEndAtFadeCutHold({
      intro,
      sharedAudio,
      mainEpisode: episode,
      boundaryContext
    });
  }
  intro = await snapIntroEndToNearbySceneChange({
    intro,
    sharedAudio,
    mainEpisode: episode,
    pairwiseRuns,
    minLen,
    maxLen,
    mainFile,
    runCommand,
    getMeanDiagonalSimilarityForRefs
  });
  return formatSecondRange(intro.startSeconds, intro.endSeconds);
}

// lib/matcher.js
var ANALYZE_SECONDS = 300;
var SAMPLE_RATE = 8e3;
var FRAME_WINDOW_SECONDS2 = 0.5;
var FRAME_HOP_SECONDS2 = 0.25;
var MIN_INTRO_SECONDS = 20;
var MAX_INTRO_SECONDS = 150;
var MAX_REFERENCE_FILES = 4;
var DIAGONAL_SMOOTH_RADIUS = 1;
var RUN_GAP_FRAMES = 2;
var CONSENSUS_TOLERANCE_SECONDS = 4;
var DISTINCT_WINDOW_SECONDS = 8;
var MAX_RUNS_PER_REFERENCE = 12;
var SINGLE_REFERENCE_RUNS_PER_REFERENCE = 3;
var SINGLE_REFERENCE_CANDIDATE_PENALTY = 6;
var SINGLE_REFERENCE_CONSENSUS_SCORE = 0.25;
var SINGLE_REFERENCE_RESCUE_MIN_SECONDS = 35;
var SINGLE_REFERENCE_RESCUE_FULL_SECONDS = 80;
var BOUNDARY_SEARCH_SECONDS = 6;
var BOUNDARY_WINDOW_SECONDS = 2;
var BOUNDARY_OUTWARD_SECONDS2 = 5;
var DIAGONAL_WALK_SECONDS = 12;
var DIAGONAL_WALK_SCORE_TOLERANCE = 0.04;
var DIAGONAL_WALK_DISTANCE_PENALTY = 6e-3;
var DEFAULT_OPTIONS = {
  analyzeSeconds: ANALYZE_SECONDS,
  sampleRate: SAMPLE_RATE,
  minIntro: MIN_INTRO_SECONDS,
  maxIntro: MAX_INTRO_SECONDS,
  minConfidence: 0.65
};
var IntroMatchError = class extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "IntroMatchError";
    this.code = code;
    this.details = details;
  }
};
function smoothSequence(values, radius = DIAGONAL_SMOOTH_RADIUS) {
  if (!values.length || radius <= 0) {
    return Float32Array.from(values);
  }
  const prefix = prefixSums(values);
  const smoothed = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const start = Math.max(0, index - radius);
    const end = Math.min(values.length, index + radius + 1);
    smoothed[index] = rangeMean(prefix, start, end);
  }
  return smoothed;
}
function buildNormalizedMatchFrames(melFrames) {
  if (!melFrames.length) {
    return [];
  }
  const frameCount = melFrames.length;
  const featureCount = MEL_BANDS * 2;
  const rows = new Array(frameCount);
  const columnSums = new Float64Array(featureCount);
  const columnSumSquares = new Float64Array(featureCount);
  for (let index = 0; index < frameCount; index += 1) {
    const current = melFrames[index];
    const previous = melFrames[Math.max(0, index - 1)];
    const next = melFrames[Math.min(frameCount - 1, index + 1)];
    const row = new Float32Array(featureCount);
    for (let band = 0; band < MEL_BANDS; band += 1) {
      const melValue = current[band];
      row[band] = melValue;
      columnSums[band] += melValue;
      columnSumSquares[band] += melValue * melValue;
      const deltaValue = (next[band] - previous[band]) * 0.5;
      const deltaIndex = MEL_BANDS + band;
      row[deltaIndex] = deltaValue;
      columnSums[deltaIndex] += deltaValue;
      columnSumSquares[deltaIndex] += deltaValue * deltaValue;
    }
    rows[index] = row;
  }
  const means = new Float64Array(featureCount);
  const inverseStddevs = new Float64Array(featureCount);
  for (let column = 0; column < featureCount; column += 1) {
    const average = columnSums[column] / frameCount;
    const variance = columnSumSquares[column] / frameCount - average * average;
    means[column] = average;
    inverseStddevs[column] = 1 / Math.sqrt(variance > 1e-12 ? variance : 1);
  }
  for (const row of rows) {
    let sumSquares = 0;
    for (let column = 0; column < featureCount; column += 1) {
      const normalized = (row[column] - means[column]) * inverseStddevs[column];
      row[column] = normalized;
      sumSquares += normalized * normalized;
    }
    if (sumSquares <= 1e-12) {
      row.fill(0);
      continue;
    }
    const scale = 1 / Math.sqrt(sumSquares);
    for (let column = 0; column < featureCount; column += 1) {
      row[column] *= scale;
    }
  }
  return rows;
}
function buildPairwiseSimilarity(mainFrames, refFrames) {
  const similarity = new Array(mainFrames.length);
  for (let i = 0; i < mainFrames.length; i += 1) {
    const row = new Float32Array(refFrames.length);
    for (let j = 0; j < refFrames.length; j += 1) {
      row[j] = dotProduct(mainFrames[i], refFrames[j]);
    }
    similarity[i] = row;
  }
  return similarity;
}
function finalizeDiagonalRun({
  runs,
  delta,
  startIndex,
  values,
  prefix,
  runStart,
  runEnd,
  minLen,
  maxLen,
  strongThreshold,
  weakThreshold,
  diagonalMean
}) {
  let start = runStart;
  let end = runEnd;
  while (start < end && values[start] < weakThreshold) {
    start += 1;
  }
  while (start < end && values[end - 1] < weakThreshold) {
    end -= 1;
  }
  if (end - start < minLen) {
    return;
  }
  if (end - start > maxLen) {
    const trimBoth = Math.floor((end - start - maxLen) / 2);
    start += trimBoth;
    end = start + maxLen;
  }
  const length = end - start;
  if (length < minLen) {
    return;
  }
  let strongCount = 0;
  let goodCount = 0;
  let minValue = Number.POSITIVE_INFINITY;
  for (let index = start; index < end; index += 1) {
    const value = values[index];
    if (value >= strongThreshold) {
      strongCount += 1;
    }
    if (value >= weakThreshold) {
      goodCount += 1;
    }
    if (value < minValue) {
      minValue = value;
    }
  }
  const consistency = goodCount / length;
  if (strongCount < Math.max(4, Math.floor(length * 0.12)) || consistency < 0.7) {
    return;
  }
  const meanSimilarity = rangeMean(prefix, start, end);
  const baseline = Math.max(diagonalMean, weakThreshold - 0.04);
  const score = length * Math.max(0.02, meanSimilarity - baseline + 0.08) * (0.7 + consistency * 0.6);
  const mainStart = startIndex + start;
  const refStart = mainStart + delta;
  runs.push({
    mainStart,
    mainEnd: mainStart + length,
    refStart,
    refEnd: refStart + length,
    delta,
    length,
    meanSimilarity,
    consistency,
    minValue,
    score,
    strongThreshold,
    weakThreshold
  });
}
function intervalClose(a, b, toleranceFrames) {
  return Math.abs(a.mainStart - b.mainStart) <= toleranceFrames && Math.abs(a.mainEnd - b.mainEnd) <= toleranceFrames;
}
function dedupeRuns(runs, toleranceFrames) {
  const kept = [];
  for (const run of runs) {
    if (kept.some((other) => intervalClose(run, other, toleranceFrames))) {
      continue;
    }
    kept.push(run);
  }
  return kept;
}
function mergeRelatedRuns(runs, maxLen) {
  const deltaToleranceFrames = Math.round(1.25 / FRAME_HOP_SECONDS2);
  const gapToleranceFrames = Math.round(2 / FRAME_HOP_SECONDS2);
  const merged = [...runs].sort(
    (a, b) => lexicographicDescending(
      [-a.mainStart, -a.mainEnd, -a.length],
      [-b.mainStart, -b.mainEnd, -b.length]
    )
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < merged.length; i += 1) {
      for (let j = i + 1; j < merged.length; j += 1) {
        const a = merged[i];
        const b = merged[j];
        const overlap = Math.min(a.mainEnd, b.mainEnd) - Math.max(a.mainStart, b.mainStart);
        const gap = Math.max(a.mainStart, b.mainStart) - Math.min(a.mainEnd, b.mainEnd);
        if (Math.abs(a.delta - b.delta) > deltaToleranceFrames) {
          continue;
        }
        if (overlap < Math.max(0, Math.min(a.length, b.length) * 0.15) && gap > gapToleranceFrames) {
          continue;
        }
        const unionStart = Math.min(a.mainStart, b.mainStart);
        const unionEnd = Math.max(a.mainEnd, b.mainEnd);
        const unionLength = unionEnd - unionStart;
        if (unionLength > maxLen) {
          continue;
        }
        const weightedDelta = Math.round(
          (a.delta * a.length + b.delta * b.length) / Math.max(1, a.length + b.length)
        );
        const meanSimilarity = (a.meanSimilarity * a.length + b.meanSimilarity * b.length) / Math.max(1, a.length + b.length);
        const consistency = (a.consistency * a.length + b.consistency * b.length) / Math.max(1, a.length + b.length);
        merged[i] = {
          ...a,
          mainStart: unionStart,
          mainEnd: unionEnd,
          refStart: unionStart + weightedDelta,
          refEnd: unionEnd + weightedDelta,
          delta: weightedDelta,
          length: unionLength,
          meanSimilarity,
          consistency,
          minValue: Math.min(a.minValue, b.minValue),
          score: unionLength * Math.max(0.02, meanSimilarity - 0.28 + consistency * 0.05) + (a.score + b.score) * 0.15
        };
        merged.splice(j, 1);
        changed = true;
        break;
      }
      if (changed) {
        break;
      }
    }
  }
  return merged;
}
function findPairwiseRuns(mainEpisode, refEpisode, minLen, maxLen, refIndex) {
  const similarity = buildPairwiseSimilarity(mainEpisode.frames, refEpisode.frames);
  const runs = [];
  const mainLength = mainEpisode.frames.length;
  const refLength = refEpisode.frames.length;
  for (let delta = -mainLength + 1; delta < refLength; delta += 1) {
    const startIndex = Math.max(0, -delta);
    const endIndex = Math.min(mainLength, refLength - delta);
    const diagonalLength = endIndex - startIndex;
    if (diagonalLength < minLen) {
      continue;
    }
    const raw = new Float32Array(diagonalLength);
    for (let offset = 0; offset < diagonalLength; offset += 1) {
      const mainIndex = startIndex + offset;
      raw[offset] = similarity[mainIndex][mainIndex + delta];
    }
    const values = smoothSequence(raw);
    const diagonalMean = mean(values);
    const diagonalStd = stddev(values, diagonalMean);
    const strongThreshold = clamp(diagonalMean + Math.max(0.06, diagonalStd * 0.9), 0.38, 0.82);
    const weakThreshold = clamp(strongThreshold - 0.08, 0.28, 0.78);
    const prefix = prefixSums(values);
    const finalizeRun = (runEnd) => finalizeDiagonalRun({
      runs,
      delta,
      startIndex,
      values,
      prefix,
      runStart,
      runEnd,
      minLen,
      maxLen,
      strongThreshold,
      weakThreshold,
      diagonalMean
    });
    let runStart = -1;
    let gapFrames = 0;
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      const isStrong = value >= strongThreshold;
      const isGood = value >= weakThreshold;
      if (runStart === -1) {
        if (isStrong) {
          runStart = index;
          gapFrames = 0;
        }
        continue;
      }
      if (isGood) {
        gapFrames = 0;
        continue;
      }
      if (gapFrames < RUN_GAP_FRAMES) {
        gapFrames += 1;
        continue;
      }
      finalizeRun(index - gapFrames);
      runStart = isStrong ? index : -1;
      gapFrames = 0;
    }
    if (runStart !== -1) {
      finalizeRun(values.length);
    }
  }
  const toleranceFrames = Math.round(CONSENSUS_TOLERANCE_SECONDS / FRAME_HOP_SECONDS2);
  const mergedRuns = mergeRelatedRuns(runs, maxLen);
  mergedRuns.sort(
    (a, b) => lexicographicDescending(
      [a.length, a.score, a.meanSimilarity, -a.mainStart],
      [b.length, b.score, b.meanSimilarity, -b.mainStart]
    )
  );
  return {
    refIndex,
    similarity,
    runs: dedupeRuns(mergedRuns, toleranceFrames).slice(0, MAX_RUNS_PER_REFERENCE)
  };
}
function buildCandidateFromRuns(runs, totalRefs, minLen, maxLen) {
  if (!runs.length) {
    return null;
  }
  const starts = runs.map((run) => run.mainStart);
  const ends = runs.map((run) => run.mainEnd);
  const overlapStart = Math.max(...starts);
  const overlapEnd = Math.min(...ends);
  const startSpread = Math.max(...starts) - Math.min(...starts);
  const endSpread = Math.max(...ends) - Math.min(...ends);
  const mainStart = Math.round(median(starts));
  const mainEnd = Math.round(median(ends));
  const duration = mainEnd - mainStart;
  if (duration < minLen || duration > maxLen) {
    return null;
  }
  const overlap = Math.max(0, overlapEnd - overlapStart);
  const referenceSupport = runs.length / totalRefs;
  const overlapRatio = duration > 0 ? overlap / duration : 0;
  const consistency = mean(runs.map((run) => run.consistency));
  const similarityScore = mean(runs.map((run) => run.meanSimilarity));
  const consensusScore = totalRefs === 1 ? 0.75 : runs.length === 1 ? SINGLE_REFERENCE_CONSENSUS_SCORE : clamp(1 - (startSpread + endSpread) / Math.max(1, duration), 0, 1);
  const totalScore = duration * Math.max(0.02, similarityScore - 0.34 + consistency * 0.04) + overlap * 0.7 + consensusScore * 8 + referenceSupport * 5 - (startSpread + endSpread) * 0.3 - mainStart * 0.01;
  return {
    mainStart,
    mainEnd,
    duration,
    overlap,
    overlapRatio,
    totalScore,
    similarityScore,
    consistencyScore: consistency,
    consensusScore,
    referenceSupport,
    totalReferences: totalRefs,
    singleReferenceRescueScore: 0,
    startSpread,
    endSpread,
    boundaryScore: 0,
    refs: runs.map((run) => ({
      refIndex: run.refIndex,
      delta: run.delta,
      refStart: mainStart + run.delta,
      refEnd: mainEnd + run.delta,
      similarity: run.meanSimilarity,
      startEdgeSimilarity: 0,
      endEdgeSimilarity: 0,
      pairScore: run.score,
      weakThreshold: run.weakThreshold,
      strongThreshold: run.strongThreshold
    }))
  };
}
function runsAgreeOnTimeline(a, b, minLen, toleranceFrames) {
  const overlap = Math.min(a.mainEnd, b.mainEnd) - Math.max(a.mainStart, b.mainStart);
  const startSpread = Math.abs(a.mainStart - b.mainStart);
  const endSpread = Math.abs(a.mainEnd - b.mainEnd);
  return overlap >= Math.floor(minLen * 0.5) || startSpread <= toleranceFrames && endSpread <= toleranceFrames;
}
function chooseBestConsensusRun(seed, pair, selectedRuns, minLen, toleranceFrames) {
  let bestRun = null;
  let bestKey = null;
  for (const run of pair.runs) {
    const agreedWithAll = selectedRuns.every(
      (selected) => runsAgreeOnTimeline(selected, run, minLen, toleranceFrames)
    );
    if (!agreedWithAll || !runsAgreeOnTimeline(seed, run, minLen, toleranceFrames)) {
      continue;
    }
    const medianStart = median(selectedRuns.map((selected) => selected.mainStart));
    const medianEnd = median(selectedRuns.map((selected) => selected.mainEnd));
    const distance = Math.abs(run.mainStart - medianStart) + Math.abs(run.mainEnd - medianEnd);
    const key = [distance * -1, run.score, run.meanSimilarity, run.length];
    if (!bestRun || lexicographicDescending(key, bestKey) < 0) {
      bestRun = run;
      bestKey = key;
    }
  }
  return bestRun;
}
function buildSingleReferenceCandidates(pairwiseRuns, minLen, maxLen) {
  const candidates = [];
  for (const pair of pairwiseRuns) {
    for (const run of pair.runs.slice(0, SINGLE_REFERENCE_RUNS_PER_REFERENCE)) {
      const candidate = buildCandidateFromRuns(
        [{ ...run, refIndex: pair.refIndex }],
        pairwiseRuns.length,
        minLen,
        maxLen
      );
      if (!candidate) {
        continue;
      }
      candidate.totalScore -= SINGLE_REFERENCE_CANDIDATE_PENALTY;
      candidates.push(candidate);
    }
  }
  return candidates;
}
function buildConsensusCandidates(pairwiseRuns, minLen, maxLen) {
  if (pairwiseRuns.length === 1) {
    return pairwiseRuns[0].runs.map(
      (run) => buildCandidateFromRuns([{ ...run, refIndex: pairwiseRuns[0].refIndex }], 1, minLen, maxLen)
    ).filter(Boolean);
  }
  const candidates = [];
  const toleranceFrames = Math.round(CONSENSUS_TOLERANCE_SECONDS / FRAME_HOP_SECONDS2);
  const allRuns = pairwiseRuns.flatMap(
    (pair) => pair.runs.map((run) => ({
      ...run,
      refIndex: pair.refIndex
    }))
  );
  for (const seed of allRuns) {
    const selectedRuns = [seed];
    for (const pair of pairwiseRuns) {
      if (pair.refIndex === seed.refIndex) {
        continue;
      }
      const bestRun = chooseBestConsensusRun(seed, pair, selectedRuns, minLen, toleranceFrames);
      if (bestRun) {
        selectedRuns.push({
          ...bestRun,
          refIndex: pair.refIndex
        });
      }
    }
    if (selectedRuns.length < 2) {
      continue;
    }
    const candidate = buildCandidateFromRuns(selectedRuns, pairwiseRuns.length, minLen, maxLen);
    if (candidate) {
      candidates.push(candidate);
    }
  }
  candidates.push(...buildSingleReferenceCandidates(pairwiseRuns, minLen, maxLen));
  candidates.sort(
    (a, b) => lexicographicDescending(
      [a.totalScore, a.duration, a.similarityScore, -a.mainStart],
      [b.totalScore, b.duration, b.similarityScore, -b.mainStart]
    )
  );
  const deduped = [];
  for (const candidate of candidates) {
    if (deduped.some(
      (other) => Math.abs(candidate.mainStart - other.mainStart) <= toleranceFrames && Math.abs(candidate.mainEnd - other.mainEnd) <= toleranceFrames
    )) {
      continue;
    }
    deduped.push(candidate);
  }
  return deduped;
}
function diagonalAverage(matrix, delta, start, end) {
  let sum = 0;
  let count = 0;
  for (let i = start; i < end; i += 1) {
    if (i < 0 || i >= matrix.length) {
      continue;
    }
    const j = i + delta;
    if (j < 0 || j >= matrix[i].length) {
      continue;
    }
    sum += matrix[i][j];
    count += 1;
  }
  return count ? sum / count : null;
}
function boundaryObjective(pairwise, delta, start, end, mode) {
  const window = Math.max(2, Math.round(BOUNDARY_WINDOW_SECONDS / FRAME_HOP_SECONDS2));
  const matrix = pairwise.similarity;
  if (mode === "start") {
    const inside2 = diagonalAverage(matrix, delta, start, Math.min(end, start + window));
    const outside2 = diagonalAverage(matrix, delta, Math.max(0, start - window), start);
    const whole2 = diagonalAverage(matrix, delta, start, end);
    if (inside2 === null || whole2 === null) {
      return null;
    }
    return {
      score: whole2 + (inside2 - (outside2 ?? inside2 - 0.02)) * 0.9,
      edge: inside2 - (outside2 ?? inside2 - 0.02),
      similarity: whole2
    };
  }
  const inside = diagonalAverage(matrix, delta, Math.max(start, end - window), end);
  const outside = diagonalAverage(matrix, delta, end, end + window);
  const whole = diagonalAverage(matrix, delta, start, end);
  if (inside === null || whole === null) {
    return null;
  }
  return {
    score: whole + (inside - (outside ?? inside - 0.02)) * 0.9,
    edge: inside - (outside ?? inside - 0.02),
    similarity: whole
  };
}
function findPairwiseRun(pairwiseRuns, refIndex) {
  return pairwiseRuns.find((pair) => pair.refIndex === refIndex);
}
function enrichReferenceMatches(candidate, pairwiseRuns) {
  const refs = candidate.refs.map((detail) => {
    const pairwise = findPairwiseRun(pairwiseRuns, detail.refIndex);
    const startMetrics = boundaryObjective(
      pairwise,
      detail.delta,
      candidate.mainStart,
      candidate.mainEnd,
      "start"
    );
    const endMetrics = boundaryObjective(
      pairwise,
      detail.delta,
      candidate.mainStart,
      candidate.mainEnd,
      "end"
    );
    const similarity = diagonalAverage(
      pairwise.similarity,
      detail.delta,
      candidate.mainStart,
      candidate.mainEnd
    );
    return {
      ...detail,
      refStart: candidate.mainStart + detail.delta,
      refEnd: candidate.mainEnd + detail.delta,
      similarity: similarity ?? detail.similarity,
      startEdgeSimilarity: startMetrics?.edge ?? 0,
      endEdgeSimilarity: endMetrics?.edge ?? 0
    };
  });
  const boundaryEdges = refs.flatMap((detail) => [
    detail.startEdgeSimilarity,
    detail.endEdgeSimilarity
  ]);
  return {
    ...candidate,
    refs,
    similarityScore: mean(refs.map((detail) => detail.similarity)),
    boundaryScore: mean(boundaryEdges)
  };
}
function sharedAudioBoundaryScore(candidate, pairwiseRuns, start, end, mode) {
  const scores = [];
  for (const detail of candidate.refs) {
    const pairwise = findPairwiseRun(pairwiseRuns, detail.refIndex);
    if (!pairwise) {
      continue;
    }
    const metrics = boundaryObjective(pairwise, detail.delta, start, end, mode);
    if (metrics) {
      scores.push(metrics.edge * 1.1 + metrics.similarity * 0.6);
    }
  }
  if (!scores.length) {
    return null;
  }
  return {
    score: mean(scores)
  };
}
function computeDiagonalNoiseThreshold(matrix, delta) {
  const diagValues = [];
  for (let i = 0; i < matrix.length; i += 1) {
    const j = i + delta;
    if (j >= 0 && j < matrix[i].length) {
      diagValues.push(matrix[i][j]);
    }
  }
  if (!diagValues.length) {
    return Number.POSITIVE_INFINITY;
  }
  const diagMean = mean(diagValues);
  const diagStd = stddev(diagValues, diagMean);
  return diagMean + diagStd * 0.2;
}
function findWalkedForwardEnd(candidate, pairwiseRuns, baseEnd, maxAllowedEnd) {
  const baseBoundary = sharedAudioBoundaryScore(
    candidate,
    pairwiseRuns,
    candidate.mainStart,
    baseEnd,
    "end"
  );
  if (!baseBoundary) {
    return null;
  }
  const walkLimit = Math.min(
    maxAllowedEnd,
    baseEnd + Math.round(DIAGONAL_WALK_SECONDS / FRAME_HOP_SECONDS2)
  );
  if (walkLimit <= baseEnd) {
    return null;
  }
  const reachableEnds = [];
  for (const detail of candidate.refs) {
    const pairwise = findPairwiseRun(pairwiseRuns, detail.refIndex);
    if (!pairwise) {
      continue;
    }
    const matrix = pairwise.similarity;
    const noiseThreshold = computeDiagonalNoiseThreshold(matrix, detail.delta);
    let currentEnd = baseEnd;
    while (currentEnd < walkLimit) {
      const localSim = diagonalAverage(matrix, detail.delta, currentEnd, currentEnd + 3);
      if (localSim === null || localSim < noiseThreshold) {
        break;
      }
      currentEnd += 1;
    }
    if (currentEnd > baseEnd) {
      reachableEnds.push(currentEnd);
    }
  }
  if (!reachableEnds.length) {
    return null;
  }
  const maxReachableEnd = Math.min(maxAllowedEnd, Math.max(...reachableEnds));
  let bestEnd = baseEnd;
  let bestScore = baseBoundary.score;
  for (let end = baseEnd + 1; end <= maxReachableEnd; end += 1) {
    const boundary = sharedAudioBoundaryScore(
      candidate,
      pairwiseRuns,
      candidate.mainStart,
      end,
      "end"
    );
    if (!boundary || boundary.score < baseBoundary.score - DIAGONAL_WALK_SCORE_TOLERANCE) {
      continue;
    }
    const distancePenalty = (end - baseEnd) * DIAGONAL_WALK_DISTANCE_PENALTY;
    const score = boundary.score - distancePenalty;
    if (score > bestScore) {
      bestScore = score;
      bestEnd = end;
    }
  }
  return bestEnd > baseEnd ? bestEnd : null;
}
function melFrameL2Distance(a, b) {
  let sumSquares = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = a[index] - b[index];
    sumSquares += diff * diff;
  }
  return Math.sqrt(sumSquares);
}
function meanMelFrameDelta(mainEpisode, start, end) {
  if (!mainEpisode?.boundaryMel?.length) {
    return 0;
  }
  if (mainEpisode.boundaryDeltaPrefix) {
    const clampedStart2 = Math.max(1, start);
    const clampedEnd2 = Math.min(end, mainEpisode.boundaryMel.length);
    return clampedEnd2 > clampedStart2 ? rangeMean(mainEpisode.boundaryDeltaPrefix, clampedStart2, clampedEnd2) : 0;
  }
  let total = 0;
  let count = 0;
  const clampedStart = Math.max(1, start);
  const clampedEnd = Math.min(end, mainEpisode.boundaryMel.length);
  for (let index = clampedStart; index < clampedEnd; index += 1) {
    total += melFrameL2Distance(mainEpisode.boundaryMel[index - 1], mainEpisode.boundaryMel[index]);
    count += 1;
  }
  return count ? total / count : 0;
}
function meanDiagonalSimilarityForRefs(candidate, pairwiseRuns, start, end) {
  const similarities = [];
  for (const detail of candidate.refs) {
    const pairwise = findPairwiseRun(pairwiseRuns, detail.refIndex);
    if (!pairwise) {
      continue;
    }
    const similarity = diagonalAverage(pairwise.similarity, detail.delta, start, end);
    if (similarity !== null) {
      similarities.push(similarity);
    }
  }
  return similarities.length ? mean(similarities) : null;
}
function getPostProcessHooks() {
  return {
    getMeanDiagonalSimilarityForRefs: meanDiagonalSimilarityForRefs,
    getSharedAudioBoundaryScore: sharedAudioBoundaryScore
  };
}
async function postProcessIntroFromSharedAudio2(sharedAudio, mainEpisode, pairwiseRuns, minLen, maxLen, mainFile, runCommand) {
  return postProcessIntroFromSharedAudio({
    sharedAudio,
    mainEpisode,
    pairwiseRuns,
    minLen,
    maxLen,
    mainFile,
    runCommand,
    ...getPostProcessHooks()
  });
}
function findBestBoundaryFrame({
  originalCandidate,
  matchCandidate,
  pairwiseRuns,
  mode,
  start,
  end,
  minFrame,
  maxFrame
}) {
  const originalFrame = mode === "start" ? originalCandidate.mainStart : originalCandidate.mainEnd;
  let bestFrame = mode === "start" ? start : end;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let frame = minFrame; frame <= maxFrame; frame += 1) {
    const testStart = mode === "start" ? frame : start;
    const testEnd = mode === "end" ? frame : end;
    const boundary = sharedAudioBoundaryScore(
      matchCandidate,
      pairwiseRuns,
      testStart,
      testEnd,
      mode
    );
    if (!boundary) {
      continue;
    }
    const score = boundary.score - Math.abs(frame - originalFrame) * 0.015;
    if (score > bestScore) {
      bestScore = score;
      bestFrame = frame;
    }
  }
  return bestFrame;
}
function refineSharedAudioBoundaries(candidate, pairwiseRuns, minLen, maxLen, mainFrames) {
  const inwardFrames = Math.round(BOUNDARY_SEARCH_SECONDS / FRAME_HOP_SECONDS2);
  const outwardFrames = Math.round(BOUNDARY_OUTWARD_SECONDS2 / FRAME_HOP_SECONDS2);
  let refined = { ...candidate };
  for (let pass = 0; pass < 2; pass += 1) {
    const minStart = Math.max(0, refined.mainStart - outwardFrames);
    const maxStart = Math.min(refined.mainEnd - minLen, refined.mainStart + inwardFrames);
    refined.mainStart = findBestBoundaryFrame({
      originalCandidate: candidate,
      matchCandidate: refined,
      pairwiseRuns,
      mode: "start",
      start: refined.mainStart,
      end: refined.mainEnd,
      minFrame: minStart,
      maxFrame: maxStart
    });
    const minEnd = Math.max(refined.mainStart + minLen, refined.mainEnd - inwardFrames);
    const maxEnd = Math.min(mainFrames, refined.mainEnd + outwardFrames);
    refined.mainEnd = findBestBoundaryFrame({
      originalCandidate: candidate,
      matchCandidate: refined,
      pairwiseRuns,
      mode: "end",
      start: refined.mainStart,
      end: refined.mainEnd,
      minFrame: minEnd,
      maxFrame: maxEnd
    });
    const maxAllowedEnd = Math.min(mainFrames, refined.mainStart + maxLen);
    const walkedEnd = findWalkedForwardEnd(
      refined,
      pairwiseRuns,
      refined.mainEnd,
      maxAllowedEnd
    );
    if (walkedEnd !== null) {
      refined.mainEnd = walkedEnd;
    }
    refined.duration = refined.mainEnd - refined.mainStart;
  }
  return enrichReferenceMatches(refined, pairwiseRuns);
}
function isDistinctCandidate(a, b, tolerance = DISTINCT_WINDOW_SECONDS) {
  const toleranceFrames = Math.max(1, Math.round(tolerance / FRAME_HOP_SECONDS2));
  return Math.abs(a.mainStart - b.mainStart) >= toleranceFrames || Math.abs(a.mainEnd - b.mainEnd) >= toleranceFrames;
}
function confidenceLabel(score) {
  if (score >= 0.75) {
    return "high";
  }
  if (score >= 0.5) {
    return "medium";
  }
  return "low";
}
function singleReferenceRescueConfidence(best, simConf, boundaryConf) {
  if (best.refs.length !== 1 || best.totalReferences <= 1) {
    return 0;
  }
  const durationSeconds = best.duration * FRAME_HOP_SECONDS2;
  const durationConf = clamp(
    (durationSeconds - SINGLE_REFERENCE_RESCUE_MIN_SECONDS) / (SINGLE_REFERENCE_RESCUE_FULL_SECONDS - SINGLE_REFERENCE_RESCUE_MIN_SECONDS),
    0,
    1
  );
  const qualityConf = Math.min(simConf, durationConf);
  return qualityConf * (0.65 + boundaryConf * 0.35);
}
function computeConfidence(best, candidates) {
  let altGap = 0.12;
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (isDistinctCandidate(best, candidate)) {
      altGap = Math.max(0, best.totalScore - candidate.totalScore);
      break;
    }
  }
  const simConf = clamp((best.similarityScore - 0.42) / 0.2, 0, 1);
  const overlapConf = clamp((best.overlapRatio - 0.3) / 0.45, 0, 1);
  const boundaryConf = clamp((best.boundaryScore - 0.02) / 0.18, 0, 1);
  const singletonRescueConf = singleReferenceRescueConfidence(best, simConf, boundaryConf);
  const supportConf = Math.max(
    clamp((best.referenceSupport - 0.45) / 0.5, 0, 1),
    singletonRescueConf * 0.85
  );
  const consensusConf = Math.max(
    clamp(best.consensusScore, 0, 1),
    singletonRescueConf * 0.7
  );
  const gapConf = clamp((altGap - 1.5) / 8, 0, 1);
  const confidence = simConf * 0.35 + supportConf * 0.15 + overlapConf * 0.15 + consensusConf * 0.15 + boundaryConf * 0.1 + gapConf * 0.1;
  return {
    confidence,
    gap: altGap,
    label: confidenceLabel(confidence),
    singletonRescue: singletonRescueConf
  };
}
function candidateSortKey(candidate) {
  return [
    candidate.totalScore,
    candidate.duration,
    candidate.similarityScore,
    candidate.referenceSupport,
    -candidate.mainStart
  ];
}
function reportProgress(onProgress, stage) {
  if (typeof onProgress === "function") {
    onProgress(stage);
  }
}
function selectBestCandidate(candidates) {
  candidates.sort((a, b) => lexicographicDescending(candidateSortKey(a), candidateSortKey(b)));
  const best = candidates[0];
  const confidence = computeConfidence(best, candidates);
  best.confidenceScore = confidence.confidence;
  best.scoreGap = confidence.gap;
  best.confidenceLabel = confidence.label;
  best.singleReferenceRescueScore = confidence.singletonRescue;
  return best;
}
function toInt16Array(bytes) {
  if (bytes instanceof Int16Array) {
    return bytes;
  }
  let view;
  if (bytes instanceof Uint8Array) {
    view = bytes;
  } else if (bytes instanceof ArrayBuffer) {
    view = new Uint8Array(bytes);
  } else {
    throw new IntroMatchError(
      "INVALID_PCM_OUTPUT",
      "Decoded audio bytes were not returned as bytes.",
      { receivedType: typeof bytes }
    );
  }
  const byteLength = view.byteLength - view.byteLength % 2;
  const dataView = new DataView(view.buffer, view.byteOffset, byteLength);
  const sampleCount = byteLength / 2;
  const samples = new Int16Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = dataView.getInt16(index * 2, true);
  }
  return samples;
}
function mapCommandFailure(error, command, details = {}) {
  if (error instanceof IntroMatchError) {
    return error;
  }
  if (error && error.code === "ENOENT") {
    return new IntroMatchError("TOOL_MISSING", `${command} not found in PATH.`, {
      tool: command,
      ...details
    });
  }
  return new IntroMatchError("COMMAND_FAILED", `${command} execution failed.`, {
    tool: command,
    cause: error instanceof Error ? error.message : String(error),
    ...details
  });
}
async function ensureToolAvailable(tool, runCommand) {
  let result;
  try {
    result = await runCommand({
      command: tool,
      args: ["-version"],
      stdoutMode: "text"
    });
  } catch (error) {
    throw mapCommandFailure(error, tool, { phase: "tool_check" });
  }
  if (result.code !== 0) {
    throw new IntroMatchError("TOOL_MISSING", `${tool} not found in PATH.`, {
      tool,
      stderr: result.stderr,
      phase: "tool_check"
    });
  }
}
async function extractPcmMono16le(path, seconds, sampleRate, runCommand) {
  let result;
  try {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      path,
      "-map",
      "0:a:0",
      "-t",
      String(seconds)
    ];
    args.push("-ac", "1", "-ar", String(sampleRate), "-vn", "-sn", "-dn", "-f", "s16le", "pipe:1");
    result = await runCommand({
      command: "ffmpeg",
      args,
      stdoutMode: "bytes"
    });
  } catch (error) {
    throw mapCommandFailure(error, "ffmpeg", { path, phase: "decode" });
  }
  if (result.code !== 0) {
    throw new IntroMatchError("FFMPEG_FAILED", `ffmpeg failed for ${path}.`, {
      path,
      stderr: result.stderr
    });
  }
  return toInt16Array(result.stdout);
}
async function buildEpisodeFeatures(path, analyzeSeconds, sampleRate, runCommand) {
  const pcm = await extractPcmMono16le(path, analyzeSeconds, sampleRate, runCommand);
  const frameSize = Math.trunc(sampleRate * FRAME_WINDOW_SECONDS2);
  const hopSize = Math.trunc(sampleRate * FRAME_HOP_SECONDS2);
  if (frameSize <= 0 || hopSize <= 0) {
    throw new IntroMatchError("INVALID_FRAME_SIZE", "Invalid analysis frame parameters.", {
      sampleRate
    });
  }
  if (pcm.length < frameSize) {
    throw new IntroMatchError("NOT_ENOUGH_AUDIO", `Not enough decoded audio in: ${path}`, { path });
  }
  const totalFrames = Math.floor((pcm.length - frameSize) / hopSize) + 1;
  const melFrames = [];
  const rmsDb = [];
  for (let index = 0; index < totalFrames; index += 1) {
    const start = index * hopSize;
    const frame = pcm.subarray(start, start + frameSize);
    const { mel, rmsDb: frameRmsDb } = frameFeatures(frame, sampleRate);
    melFrames.push(mel);
    rmsDb.push(frameRmsDb);
  }
  const frames = buildNormalizedMatchFrames(melFrames);
  const prefixRms = prefixSums(rmsDb);
  const boundaryDelta = new Float32Array(melFrames.length);
  for (let index = 1; index < melFrames.length; index += 1) {
    boundaryDelta[index] = melFrameL2Distance(melFrames[index - 1], melFrames[index]);
  }
  const boundaryDeltaPrefix = prefixSums(boundaryDelta);
  let totalVolume = 0;
  for (const value of rmsDb) {
    totalVolume += value;
  }
  const avgVolume = totalVolume / rmsDb.length;
  let variance = 0;
  for (const value of rmsDb) {
    variance += (value - avgVolume) ** 2;
  }
  return {
    path,
    frames,
    boundaryMel: melFrames,
    rmsDb,
    prefixRms,
    boundaryDeltaPrefix,
    volumeVariance: variance / rmsDb.length,
    getMeanMelFrameDelta(startFrame, endFrame) {
      return meanMelFrameDelta(this, startFrame, endFrame);
    }
  };
}
async function buildEpisodeSetFeatures(mainFile, refFiles, analyzeSeconds, sampleRate, runCommand) {
  const [mainEpisode, ...refEpisodes] = await Promise.all([
    buildEpisodeFeatures(mainFile, analyzeSeconds, sampleRate, runCommand),
    ...refFiles.map(
      (refFile) => buildEpisodeFeatures(refFile, analyzeSeconds, sampleRate, runCommand)
    )
  ]);
  return {
    mainEpisode,
    refEpisodes
  };
}
function deriveMatchFrameBounds(minIntroSec, maxIntroSec) {
  const minLen = Math.max(1, Math.floor(minIntroSec / FRAME_HOP_SECONDS2));
  const maxLen = Math.max(minLen, Math.floor(maxIntroSec / FRAME_HOP_SECONDS2));
  return {
    minLen,
    maxLen
  };
}
function ensureEpisodeHasMatchableVariance(mainEpisode) {
  if (mainEpisode.volumeVariance < 1) {
    throw new IntroMatchError(
      "NO_VALID_CANDIDATES",
      "Main episode audio appears too flat to match."
    );
  }
}
function compareEpisodeAgainstReferences(mainEpisode, refEpisodes, minLen, maxLen) {
  return refEpisodes.map(
    (episode, index) => findPairwiseRuns(mainEpisode, episode, minLen, maxLen, index + 1)
  );
}
function buildSharedAudioCandidates(pairwiseRuns, minLen, maxLen) {
  const rawCandidates = buildConsensusCandidates(pairwiseRuns, minLen, maxLen);
  if (!rawCandidates.length) {
    throw new IntroMatchError("NO_VALID_CANDIDATES", "No repeated diagonal runs found.");
  }
  return rawCandidates;
}
function refineSharedAudioCandidates(rawCandidates, pairwiseRuns, minLen, maxLen, mainFrameCount) {
  return rawCandidates.slice(0, 8).map(
    (candidate) => refineSharedAudioBoundaries(candidate, pairwiseRuns, minLen, maxLen, mainFrameCount)
  ).map((candidate) => ({
    ...candidate,
    totalScore: candidate.totalScore + candidate.boundaryScore * 6 + candidate.similarityScore * 2 + candidate.overlapRatio * 2
  }));
}
function scoreAndPickSharedAudioCandidate(candidates) {
  return selectBestCandidate(candidates);
}
function runMatchingPipeline(mainEpisode, refEpisodes, minIntroSec, maxIntroSec) {
  const { minLen, maxLen } = deriveMatchFrameBounds(minIntroSec, maxIntroSec);
  ensureEpisodeHasMatchableVariance(mainEpisode);
  const pairwiseRuns = compareEpisodeAgainstReferences(mainEpisode, refEpisodes, minLen, maxLen);
  const rawCandidates = buildSharedAudioCandidates(pairwiseRuns, minLen, maxLen);
  const refinedCandidates = refineSharedAudioCandidates(
    rawCandidates,
    pairwiseRuns,
    minLen,
    maxLen,
    mainEpisode.frames.length
  );
  const sharedAudio = scoreAndPickSharedAudioCandidate(refinedCandidates);
  return {
    sharedAudio,
    pairwiseRuns,
    minLen,
    maxLen
  };
}
function formatFrameRange(startFrame, endFrame) {
  const startSeconds = frameToSeconds(startFrame);
  const endSeconds = frameToSeconds(endFrame);
  return formatSecondRange(startSeconds, endSeconds);
}
function formatOutput(mainFile, refFiles, result, minConfidence) {
  const sharedAudioRange = formatFrameRange(
    result.sharedAudio.mainStart,
    result.sharedAudio.mainEnd
  );
  const introRange = result.intro;
  const output = {
    main_file: mainFile,
    ...sharedAudioRange,
    shared_audio: sharedAudioRange,
    intro: introRange,
    accepted: result.sharedAudio.confidenceScore >= minConfidence,
    scores: {
      total: round4(result.sharedAudio.totalScore),
      similarity: round4(result.sharedAudio.similarityScore),
      consensus: round4(result.sharedAudio.consensusScore),
      boundary: round4(result.sharedAudio.boundaryScore),
      support: round4(result.sharedAudio.referenceSupport),
      single_reference_rescue: round4(result.sharedAudio.singleReferenceRescueScore ?? 0),
      overlap: round4(result.sharedAudio.overlapRatio)
    },
    confidence: {
      score: round4(result.sharedAudio.confidenceScore),
      label: result.sharedAudio.confidenceLabel,
      gap_to_next_distinct_candidate: round4(result.sharedAudio.scoreGap),
      threshold: round4(minConfidence)
    },
    reference_matches: result.sharedAudio.refs.map((detail) => ({
      ref_file: refFiles[detail.refIndex - 1],
      ref_start_seconds: round4(detail.refStart * FRAME_HOP_SECONDS2),
      ref_end_seconds: round4(detail.refEnd * FRAME_HOP_SECONDS2),
      ref_start_hms: secondsToHms(detail.refStart * FRAME_HOP_SECONDS2),
      ref_end_hms: secondsToHms(detail.refEnd * FRAME_HOP_SECONDS2),
      similarity: round4(detail.similarity),
      start_edge_similarity: round4(detail.startEdgeSimilarity),
      end_edge_similarity: round4(detail.endEdgeSimilarity)
    }))
  };
  if (!output.accepted) {
    output.rejected_reason = `Best match confidence ${result.sharedAudio.confidenceScore.toFixed(2)} is below threshold ${minConfidence.toFixed(2)}`;
  }
  return output;
}
async function findIntroMatch({ mainFile, refFiles, options = {}, runCommand }) {
  if (typeof runCommand !== "function") {
    throw new IntroMatchError("RUN_COMMAND_REQUIRED", "A runCommand function is required.");
  }
  if (!mainFile || !Array.isArray(refFiles) || refFiles.length < 1 || refFiles.length > MAX_REFERENCE_FILES) {
    throw new IntroMatchError(
      "INVALID_FILE_COUNT",
      `Please provide MAIN plus 1 to ${MAX_REFERENCE_FILES} reference files.`,
      {
        mainFile,
        refFiles
      }
    );
  }
  const resolved = {
    ...DEFAULT_OPTIONS,
    ...options
  };
  const { onProgress } = resolved;
  reportProgress(onProgress, "checking_tools");
  await ensureToolAvailable("ffmpeg", runCommand);
  reportProgress(onProgress, "extracting_features");
  const { mainEpisode, refEpisodes } = await buildEpisodeSetFeatures(
    mainFile,
    refFiles,
    resolved.analyzeSeconds,
    resolved.sampleRate,
    runCommand
  );
  reportProgress(onProgress, "matching");
  const pipeline = runMatchingPipeline(
    mainEpisode,
    refEpisodes,
    resolved.minIntro,
    resolved.maxIntro
  );
  reportProgress(onProgress, "post_processing_intro");
  const intro = await postProcessIntroFromSharedAudio2(
    pipeline.sharedAudio,
    mainEpisode,
    pipeline.pairwiseRuns,
    pipeline.minLen,
    pipeline.maxLen,
    mainFile,
    runCommand
  );
  const result = {
    sharedAudio: pipeline.sharedAudio,
    intro
  };
  const output = formatOutput(mainFile, refFiles, result, resolved.minConfidence);
  if (!output.accepted) {
    throw new IntroMatchError("LOW_CONFIDENCE_MATCH", output.rejected_reason, {
      output,
      result
    });
  }
  return output;
}

// tools/iina-helper.js
var OPTION_PARSERS = {
  "--analyze-seconds": ["analyzeSeconds", parseInteger],
  "--sample-rate": ["sampleRate", parseInteger],
  "--min-intro": ["minIntro", parseInteger],
  "--max-intro": ["maxIntro", parseInteger],
  "--min-confidence": ["minConfidence", parseFloatValue]
};
function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}
`);
}
function parseInteger(flag, value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new IntroMatchError("INVALID_ARGUMENT", `Expected an integer for ${flag}.`, {
      flag,
      value
    });
  }
  return parsed;
}
function parseFloatValue(flag, value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new IntroMatchError("INVALID_ARGUMENT", `Expected a number for ${flag}.`, {
      flag,
      value
    });
  }
  return parsed;
}
function readOptionValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === void 0 || value.startsWith("--")) {
    throw new IntroMatchError("INVALID_ARGUMENT", `Missing value for ${flag}.`, { flag });
  }
  return value;
}
function parseRefsJson(value) {
  let refs;
  try {
    refs = JSON.parse(value);
  } catch {
    throw new IntroMatchError("INVALID_ARGUMENT", "Expected --refs-json to be a JSON array.");
  }
  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string" || !ref)) {
    throw new IntroMatchError("INVALID_ARGUMENT", "Expected --refs-json to contain file paths.");
  }
  return refs;
}
function parseArgs(argv) {
  const options = { ...DEFAULT_OPTIONS };
  let mainFile = null;
  let refFiles = [];
  let ffmpegPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const optionParser = OPTION_PARSERS[arg];
    if (optionParser) {
      const [optionKey, parser] = optionParser;
      options[optionKey] = parser(arg, readOptionValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--main") {
      mainFile = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--ref") {
      refFiles.push(readOptionValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--refs-json") {
      refFiles = parseRefsJson(readOptionValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--ffmpeg") {
      ffmpegPath = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    throw new IntroMatchError("INVALID_ARGUMENT", `Unknown argument: ${arg}`, { arg });
  }
  if (!mainFile || !Array.isArray(refFiles) || refFiles.length < 1 || refFiles.length > MAX_REFERENCE_FILES) {
    throw new IntroMatchError(
      "INVALID_FILE_COUNT",
      `Expected --main plus 1 to ${MAX_REFERENCE_FILES} refs.`,
      { mainFile, refFiles }
    );
  }
  return {
    mainFile,
    refFiles,
    options,
    commandPaths: {
      ...ffmpegPath ? { ffmpeg: ffmpegPath } : {}
    }
  };
}
function validateFiles(paths) {
  for (const path of paths) {
    if (!existsSync(path)) {
      throw new IntroMatchError("FILE_NOT_FOUND", `File not found: ${path}`, { path });
    }
  }
}
function createRunCommand(commandPaths) {
  return function runCommand({ command, args, stdoutMode = "text" }) {
    const executable = commandPaths[command] || command;
    return spawnCommand({
      command: executable,
      args,
      stdoutMode
    });
  };
}
function spawnCommand({ command, args, stdoutMode = "text" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.on("error", (error) => {
      error.command = command;
      reject(error);
    });
    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
    });
    child.on("close", (code) => {
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      resolve({
        code: code ?? 1,
        stdout: stdoutMode === "bytes" ? new Uint8Array(stdoutBuffer) : stdoutBuffer.toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8")
      });
    });
  });
}
function compactOutput(output) {
  return {
    accepted: output.accepted,
    intro: output.intro,
    shared_audio: output.shared_audio,
    confidence: output.confidence,
    scores: output.scores,
    reference_matches: output.reference_matches
  };
}
function serializeError(error) {
  if (error instanceof IntroMatchError) {
    const payload = {
      ok: false,
      code: error.code,
      message: error.message,
      details: error.details
    };
    const output = error.details?.output;
    if (output) {
      payload.output = compactOutput(output);
      delete payload.details.output;
    }
    return payload;
  }
  return {
    ok: false,
    code: "UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : String(error)
  };
}
async function main() {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    validateFiles([parsed.mainFile, ...parsed.refFiles]);
    const output = await findIntroMatch({
      mainFile: parsed.mainFile,
      refFiles: parsed.refFiles,
      options: parsed.options,
      runCommand: createRunCommand(parsed.commandPaths)
    });
    printJson({
      ok: true,
      output: compactOutput(output)
    });
  } catch (error) {
    printJson(serializeError(error));
    process.exitCode = error instanceof IntroMatchError ? 0 : 1;
  }
}
main();
