import {
  clamp,
  lexicographicDescending,
  mean,
  prefixSums,
  rangeMean,
  round4,
  secondsToHms,
} from './math.js';

const FRAME_WINDOW_SECONDS = 0.5;
const FRAME_HOP_SECONDS = 0.25;
const BOUNDARY_OUTWARD_SECONDS = 5.0;

// Silence trim config
const END_SILENCE_SEARCH_SECONDS = 3.0;
const END_SILENCE_MIN_SECONDS = 0.75;
const END_SILENCE_POST_SECONDS = 1.0;
const END_SILENCE_RMS_DB_THRESHOLD = -46.0;
const END_SILENCE_RECOVERY_DB = 6.0;

// Silent static hold intro extension config
const POST_END_AUDIO_GATE_SECONDS = 1.0;
const POST_END_SHARED_SIMILARITY_MAX = 0.35;
const POST_END_SHARED_SIMILARITY_DROP = 0.15;
const POST_END_ACTIVITY_MAX = 0.05;
const FADE_BRIDGE_SECONDS = 1.5;
const FADE_INITIAL_WINDOW_SECONDS = 0.5;
const FADE_QUIET_WINDOW_SECONDS = 0.5;
const FADE_SHAPE_WINDOW_SECONDS = 1.0;
const FADE_INITIAL_RMS_DB_MAX = -70.0;
const FADE_QUIET_RMS_DB_MAX = -80.0;
const FADE_SHAPE_INITIAL_RMS_DB_MAX = -56.0;
const FADE_SHAPE_DROP_DB_MIN = 12.0;
const FADE_SHAPE_REBOUND_DB_MAX = 2.5;
const FADE_TAIL_CONFIRM_SECONDS = 0.5;
const VIDEO_PROFILE_SECONDS = 5.5;
const VIDEO_PROFILE_LOOKAHEAD_SECONDS = 5.0;
const VIDEO_PROFILE_FPS = 6;
const VIDEO_PROFILE_WIDTH = 160;
const VIDEO_PROFILE_SCDET_THRESHOLD = 10;
const VIDEO_HOLD_START_SECONDS = 0.5;
const VIDEO_HOLD_MIN_SECONDS = 0.75;
const VIDEO_HOLD_MAFD_MAX = 0.5;
const VIDEO_HOLD_SCORE_MAX = 2.0;
const AUDIO_WAKE_WINDOW_SECONDS = 0.5;
const AUDIO_WAKE_BASELINE_SECONDS = 0.75;
const AUDIO_WAKE_RMS_DB_THRESHOLD = -40.0;
const AUDIO_WAKE_ACTIVITY_MAX = 0.12;
const AUDIO_WAKE_RELATIVE_BASELINE_RMS_DB_MAX = -54.0;
const AUDIO_WAKE_RELATIVE_CURRENT_RMS_DB_MIN = -50.0;
const AUDIO_WAKE_RISE_DB_MIN = 6.0;
const FADE_CUT_INITIAL_WINDOW_SECONDS = 0.5;
const FADE_CUT_FINAL_WINDOW_SECONDS = 0.5;
const FADE_CUT_MIN_SECONDS = 1.5;
const FADE_CUT_INITIAL_RMS_DB_MAX = -50.0;
const FADE_CUT_FINAL_RMS_DB_MAX = -56.0;
const FADE_CUT_DROP_DB_MIN = 4.0;
const FADE_CUT_REBOUND_DB_MAX = 2.5;
const FADE_CUT_PRE_WAKE_GRACE_SECONDS = 0.5;
const FADE_CUT_WAKE_WINDOW_SECONDS = 0.5;
const FADE_CUT_WAKE_PEAK_RMS_DB_MIN = -42.0;
const FADE_CUT_WAKE_RISE_DB_MIN = 8.0;
const FADE_CUT_WAKE_ACTIVITY_RISE_MIN = 0.08;
const END_SCENE_SNAP_SEARCH_SECONDS = 0.5;
const END_SCENE_SNAP_PROFILE_MARGIN_SECONDS = 0.25;
const END_SCENE_SNAP_SCORE_MIN = VIDEO_PROFILE_SCDET_THRESHOLD;
const END_SCENE_SNAP_QUIET_RMS_DB_MAX = END_SILENCE_RMS_DB_THRESHOLD + 4.0;
const END_SCENE_SNAP_ACTIVITY_MAX = 0.08;
const END_SCENE_SNAP_BACKWARD_SCORE_MIN = 12.0;
const END_SCENE_SNAP_SHARED_SIMILARITY_DROP = 0.08;
const START_SCENE_SNAP_SEARCH_SECONDS = 2.5;
const START_SCENE_SNAP_PROFILE_MARGIN_SECONDS = 0.25;
const START_SCENE_SNAP_SCORE_MIN = VIDEO_PROFILE_SCDET_THRESHOLD + 1.0;
const START_SCENE_SNAP_MIN_FORWARD_SECONDS = 0.35;
const START_SCENE_SNAP_SHORT_POST_SECONDS = 1.0;
const START_SCENE_SNAP_PLATEAU_DELAY_SECONDS = 0.5;
const START_SCENE_SNAP_PLATEAU_SECONDS = 2.0;
const START_SCENE_SNAP_SHORT_SIMILARITY_MIN = 0.74;
const START_SCENE_SNAP_PLATEAU_SIMILARITY_MIN = 0.86;
const START_SCENE_SNAP_PLATEAU_GAIN_MIN = 0.16;
const START_SCENE_SNAP_BOUNDARY_TOLERANCE = 0.28;

const SCDET_FRAME_PATTERN = /^frame:\s*(\d+)\s+pts:\s*\S+\s+pts_time:(\S+)/;
const SCDET_MAFD_PATTERN = /^lavfi\.scd\.mafd=(\S+)/;
const SCDET_SCORE_PATTERN = /^lavfi\.scd\.score=(\S+)/;

export function frameToSeconds(frame) {
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
    endFrame,
  };
}

export function formatSecondRange(startSeconds, endSeconds) {
  const normalizedStartSeconds = round4(startSeconds);
  const normalizedEndSeconds = round4(endSeconds);
  return {
    start_seconds: normalizedStartSeconds,
    end_seconds: normalizedEndSeconds,
    duration_seconds: round4(normalizedEndSeconds - normalizedStartSeconds),
    start_hms: secondsToHms(normalizedStartSeconds),
    end_hms: secondsToHms(normalizedEndSeconds),
  };
}

export function parseScdetFrames(text) {
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
        score: null,
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
    (frame) =>
      Number.isFinite(frame.ptsTime) && Number.isFinite(frame.mafd) && Number.isFinite(frame.score),
  );
}

function detectSilentStaticHoldBoundary(frames, holdStartSeconds = 0.0) {
  if (!frames.length) {
    return null;
  }

  const holdFrames = frames.filter((frame) => frame.ptsTime >= holdStartSeconds - 1e-6);
  if (!holdFrames.length) {
    return null;
  }

  const initialFrames = holdFrames.filter(
    (frame) => frame.ptsTime < holdStartSeconds + VIDEO_HOLD_START_SECONDS + 1e-6,
  );
  if (!initialFrames.length) {
    return null;
  }
  if (
    mean(initialFrames.map((frame) => frame.mafd)) > VIDEO_HOLD_MAFD_MAX ||
    Math.max(...initialFrames.map((frame) => frame.score)) >= VIDEO_HOLD_SCORE_MAX
  ) {
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

  if (
    holdEndIndex < 0 ||
    holdEndTime === null ||
    holdEndTime - holdStartSeconds + 1e-6 < VIDEO_HOLD_MIN_SECONDS
  ) {
    return null;
  }

  for (let index = holdEndIndex + 1; index < holdFrames.length - 1; index += 1) {
    const current = holdFrames[index];
    if (current.ptsTime > VIDEO_PROFILE_LOOKAHEAD_SECONDS + 1e-6) {
      break;
    }
    const previous = holdFrames[index - 1];
    const next = holdFrames[index + 1];
    if (
      current.score >= VIDEO_PROFILE_SCDET_THRESHOLD &&
      current.score >= previous.score &&
      current.score >= next.score
    ) {
      return current;
    }
  }

  return null;
}

function hasStillTailBeforeBoundary(frames, boundary, holdStartSeconds = 0.0) {
  const tailStart = Math.max(holdStartSeconds, boundary.ptsTime - FADE_TAIL_CONFIRM_SECONDS);
  const tailFrames = frames.filter(
    (frame) => frame.ptsTime >= tailStart - 1e-6 && frame.ptsTime < boundary.ptsTime - 1e-6,
  );
  if (!tailFrames.length) {
    return false;
  }

  return (
    mean(tailFrames.map((frame) => frame.mafd)) <= VIDEO_HOLD_MAFD_MAX &&
    Math.max(...tailFrames.map((frame) => frame.score)) < VIDEO_HOLD_SCORE_MAX
  );
}

function audioWindowMetrics(mainEpisode, startFrame, endFrame) {
  return {
    rms: rangeMean(mainEpisode.prefixRms, startFrame, endFrame),
    activity: mainEpisode.getMeanMelFrameDelta(startFrame, endFrame),
  };
}

function collectRmsFramesBeforeTime(
  mainEpisode,
  startFrame,
  boundaryTimeSeconds,
  minFrameEndSeconds = Number.NEGATIVE_INFINITY,
) {
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
  let maxRise = 0.0;
  for (let index = 1; index < values.length; index += 1) {
    maxRise = Math.max(maxRise, values[index] - values[index - 1]);
  }
  return maxRise;
}

function findFadeToQuietHoldStartFrame(mainEpisode, startFrame) {
  const bridgeFrames = Math.max(2, Math.round(FADE_BRIDGE_SECONDS / FRAME_HOP_SECONDS));
  const initialWindowFrames = Math.max(
    2,
    Math.round(FADE_INITIAL_WINDOW_SECONDS / FRAME_HOP_SECONDS),
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
    const baselineRms =
      frame > baselineStart ? rangeMean(mainEpisode.prefixRms, baselineStart, frame) : null;
    if (
      rms > AUDIO_WAKE_RMS_DB_THRESHOLD ||
      (rms > END_SILENCE_RMS_DB_THRESHOLD && activity > AUDIO_WAKE_ACTIVITY_MAX) ||
      (baselineRms !== null &&
        baselineSpan >= baselineFrames &&
        baselineRms <= AUDIO_WAKE_RELATIVE_BASELINE_RMS_DB_MAX &&
        rms >= AUDIO_WAKE_RELATIVE_CURRENT_RMS_DB_MIN &&
        rms - baselineRms >= AUDIO_WAKE_RISE_DB_MIN)
    ) {
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
    boundaryTimeSeconds - FADE_TAIL_CONFIRM_SECONDS,
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
    endFrame,
  );
  const fadeHoldStartFrame = findFadeToQuietHoldStartFrame(mainEpisode, startFrame);
  const fadeCutWindowFrames = Math.max(
    2,
    Math.round(FADE_CUT_INITIAL_WINDOW_SECONDS / FRAME_HOP_SECONDS),
  );
  const fadeCutInitialEnd = Math.min(mainEpisode.rmsDb.length, startFrame + fadeCutWindowFrames);
  const fadeCutInitialRms =
    fadeCutInitialEnd - startFrame >= fadeCutWindowFrames
      ? rangeMean(mainEpisode.prefixRms, startFrame, fadeCutInitialEnd)
      : Number.POSITIVE_INFINITY;
  const canTrySilentStaticHold =
    (postRms <= END_SILENCE_RMS_DB_THRESHOLD && postActivity <= POST_END_ACTIVITY_MAX) ||
    fadeHoldStartFrame !== null;
  const canTryFadeCutHold =
    fadeHoldStartFrame === null && fadeCutInitialRms <= FADE_CUT_INITIAL_RMS_DB_MAX;

  return {
    postRms,
    postActivity,
    fadeHoldStartFrame,
    canTrySilentStaticHold,
    canTryFadeCutHold,
  };
}

function withEpisodeMetrics(mainEpisode) {
  return {
    ...mainEpisode,
    getMeanMelFrameDelta: mainEpisode.getMeanMelFrameDelta ?? (() => 0.0),
  };
}

export async function getPostEndStaticBoundaryContext({
  sharedAudio,
  mainEpisode,
  pairwiseRuns,
  mainFile,
  runCommand,
  maxLen,
  getMeanDiagonalSimilarityForRefs,
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
    endFrame,
  );
  const preSharedSimilarity = getMeanDiagonalSimilarityForRefs(
    sharedAudio,
    pairwiseRuns,
    preStart,
    startFrame,
  );
  if (
    postSharedSimilarity === null ||
    preSharedSimilarity === null ||
    postSharedSimilarity > POST_END_SHARED_SIMILARITY_MAX ||
    postSharedSimilarity > preSharedSimilarity - POST_END_SHARED_SIMILARITY_DROP
  ) {
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
    runCommand,
  );
  if (!frames?.length) {
    return null;
  }

  const boundary = detectSilentStaticHoldBoundary(frames, 0.0);
  if (!boundary) {
    return null;
  }

  const boundaryTimeSeconds = sharedAudio.mainEnd * FRAME_HOP_SECONDS + boundary.ptsTime;
  const boundaryFrame = secondToFrameAtOrAfter(boundaryTimeSeconds);
  const clampedEndSeconds = Math.min(
    frameToSeconds(sharedAudio.mainStart + maxLen),
    boundaryTimeSeconds,
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
    clampedEndSeconds,
  };
}

export function hasFadingTailBeforeBoundary(mainEpisode, startFrame, boundaryTimeSeconds) {
  const episode = withEpisodeMetrics(mainEpisode);
  const minFrames = Math.max(4, Math.round(FADE_CUT_MIN_SECONDS / FRAME_HOP_SECONDS));
  const initialWindowFrames = Math.max(
    2,
    Math.round(FADE_CUT_INITIAL_WINDOW_SECONDS / FRAME_HOP_SECONDS),
  );
  const finalWindowFrames = Math.max(
    2,
    Math.round(FADE_CUT_FINAL_WINDOW_SECONDS / FRAME_HOP_SECONDS),
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

export function hasBoundaryAudioWake(mainEpisode, boundaryFrame) {
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

  return (
    postPeakRms >= FADE_CUT_WAKE_PEAK_RMS_DB_MIN ||
    postRms - preRms >= FADE_CUT_WAKE_RISE_DB_MIN ||
    postActivity - preActivity >= FADE_CUT_WAKE_ACTIVITY_RISE_MIN
  );
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

function collectNearbySceneChangeCandidates(
  frames,
  profileStartSeconds,
  anchorTimeSeconds,
  searchSeconds = END_SCENE_SNAP_SEARCH_SECONDS,
) {
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
      distanceAbs: Math.abs(distanceSeconds),
    });
  }

  candidates.sort((a, b) =>
    lexicographicDescending(
      [-a.distanceAbs, a.distanceSeconds <= 0 ? 1 : 0, a.frame.score, -a.timeSeconds],
      [-b.distanceAbs, b.distanceSeconds <= 0 ? 1 : 0, b.frame.score, -b.timeSeconds],
    ),
  );

  return candidates;
}

function hasNearbySceneSnapQuietGap(mainEpisode, startSeconds, endSeconds) {
  const frameWindow = getFrameWindowForSecondSpan(
    startSeconds,
    endSeconds,
    mainEpisode.rmsDb.length,
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

function hasNearbySceneSnapSharedDrop(
  sharedAudio,
  mainEpisode,
  pairwiseRuns,
  startSeconds,
  endSeconds,
  getMeanDiagonalSimilarityForRefs,
) {
  const gapWindow = getFrameWindowForSecondSpan(
    startSeconds,
    endSeconds,
    mainEpisode.frames.length,
  );
  if (!gapWindow) {
    return false;
  }

  const { startFrame, endFrame } = gapWindow;
  const gapSimilarity = getMeanDiagonalSimilarityForRefs(
    sharedAudio,
    pairwiseRuns,
    startFrame,
    endFrame,
  );
  if (gapSimilarity === null || gapSimilarity > POST_END_SHARED_SIMILARITY_MAX) {
    return false;
  }

  const baselineDurationSeconds = endSeconds - startSeconds;
  const baselineStartSeconds = Math.max(
    frameToSeconds(sharedAudio.mainStart),
    startSeconds - baselineDurationSeconds,
  );
  const baselineWindow = getFrameWindowForSecondSpan(
    baselineStartSeconds,
    startSeconds,
    mainEpisode.frames.length,
  );
  const baselineSimilarity = baselineWindow
    ? getMeanDiagonalSimilarityForRefs(
        sharedAudio,
        pairwiseRuns,
        baselineWindow.startFrame,
        baselineWindow.endFrame,
      )
    : null;

  return (
    baselineSimilarity === null ||
    gapSimilarity <= baselineSimilarity - END_SCENE_SNAP_SHARED_SIMILARITY_DROP
  );
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
      command: 'ffmpeg',
      args: [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String(startSeconds),
        '-t',
        String(durationSeconds),
        '-i',
        path,
        '-map',
        '0:v:0',
        '-an',
        '-sn',
        '-dn',
        '-vf',
        `fps=${VIDEO_PROFILE_FPS},scale=${VIDEO_PROFILE_WIDTH}:-2:flags=fast_bilinear,format=gray,scdet=threshold=${VIDEO_PROFILE_SCDET_THRESHOLD},metadata=mode=print:file=-`,
        '-f',
        'null',
        '-',
      ],
      stdoutMode: 'text',
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
    durationSeconds: round4(normalizedEndSeconds - intro.startSeconds),
  };
}

function setIntroStartSeconds(intro, startSeconds) {
  const normalizedStartSeconds = round4(startSeconds);

  return {
    ...intro,
    mainStart: secondToFrameAtOrAfter(normalizedStartSeconds),
    startSeconds: normalizedStartSeconds,
    durationSeconds: round4(intro.endSeconds - normalizedStartSeconds),
  };
}

function maybeExtendIntroToStaticBoundary({
  intro,
  sharedAudio,
  mainEpisode,
  boundaryContext,
  ignoreTrailingFrames = 0,
  requireBoundaryWake = false,
}) {
  if (!boundaryContext) {
    return intro;
  }

  const episode = withEpisodeMetrics(mainEpisode);
  const { frames, boundary, boundaryFrame, clampedEndFrame, clampedEndSeconds } = boundaryContext;
  if (!hasStillTailBeforeBoundary(frames, boundary, 0.0)) {
    return intro;
  }
  if (
    audioWakesBeforeBoundary(
      episode,
      sharedAudio.mainEnd,
      clampedEndFrame,
      ignoreTrailingFrames,
    )
  ) {
    return intro;
  }
  if (requireBoundaryWake && !hasBoundaryAudioWake(episode, boundaryFrame)) {
    return intro;
  }

  return setIntroEndSeconds(intro, clampedEndSeconds);
}

export function extendIntroEndAtSilentStaticHold({
  intro,
  sharedAudio,
  mainEpisode,
  boundaryContext,
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
    canTrySilentStaticHold,
  } = boundaryContext;
  if (!canTrySilentStaticHold) {
    return intro;
  }
  if (postRms > END_SILENCE_RMS_DB_THRESHOLD || postActivity > POST_END_ACTIVITY_MAX) {
    if (
      fadeHoldStartFrame === null ||
      !hasQuietTailBeforeBoundary(episode, boundaryTimeSeconds, fadeHoldStartFrame)
    ) {
      return intro;
    }
  }

  return maybeExtendIntroToStaticBoundary({ intro, sharedAudio, mainEpisode: episode, boundaryContext });
}

export function extendIntroEndAtFadeCutHold({ intro, sharedAudio, mainEpisode, boundaryContext }) {
  if (!boundaryContext) {
    return intro;
  }

  const episode = withEpisodeMetrics(mainEpisode);
  const { startFrame, boundaryTimeSeconds, canTryFadeCutHold } = boundaryContext;
  if (
    !canTryFadeCutHold ||
    !hasFadingTailBeforeBoundary(episode, startFrame, boundaryTimeSeconds)
  ) {
    return intro;
  }

  return maybeExtendIntroToStaticBoundary({
    intro,
    sharedAudio,
    mainEpisode: episode,
    boundaryContext,
    ignoreTrailingFrames: Math.max(
      2,
      Math.round(FADE_CUT_PRE_WAKE_GRACE_SECONDS / FRAME_HOP_SECONDS),
    ),
    requireBoundaryWake: true,
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
  getMeanDiagonalSimilarityForRefs,
}) {
  const episode = withEpisodeMetrics(mainEpisode);
  const anchorTimeSeconds = intro.endSeconds;
  const canExtendForwardFromSharedEnd =
    Math.abs(intro.endSeconds - frameToSeconds(sharedAudio.mainEnd)) <= 1e-6;
  const minEndSeconds = intro.startSeconds + minLen * FRAME_HOP_SECONDS;
  const maxEndSeconds = intro.startSeconds + maxLen * FRAME_HOP_SECONDS;
  const profileStartSeconds = Math.max(
    0,
    anchorTimeSeconds - END_SCENE_SNAP_SEARCH_SECONDS - END_SCENE_SNAP_PROFILE_MARGIN_SECONDS,
  );
  const profileDurationSeconds =
    END_SCENE_SNAP_SEARCH_SECONDS * 2 + END_SCENE_SNAP_PROFILE_MARGIN_SECONDS * 2;
  const potentialTimes = collectPotentialSceneProfileTimes(
    profileStartSeconds,
    profileDurationSeconds,
    VIDEO_PROFILE_FPS,
  );
  const hasBackwardWindow = potentialTimes.some(
    (timeSeconds) =>
      timeSeconds >= minEndSeconds - 1e-6 &&
      timeSeconds < anchorTimeSeconds - 1e-6 &&
      anchorTimeSeconds - timeSeconds <= END_SCENE_SNAP_SEARCH_SECONDS + 1e-6,
  );
  const hasForwardAudioCandidate =
    canExtendForwardFromSharedEnd &&
    potentialTimes.some((timeSeconds) => {
      if (
        timeSeconds <= anchorTimeSeconds + 1e-6 ||
        timeSeconds > maxEndSeconds + 1e-6 ||
        timeSeconds - anchorTimeSeconds > END_SCENE_SNAP_SEARCH_SECONDS + 1e-6
      ) {
        return false;
      }

      const boundaryFrame = secondToFrameAtOrAfter(timeSeconds);
      return (
        hasNearbySceneSnapQuietGap(episode, intro.endSeconds, timeSeconds) &&
        hasNearbySceneSnapSharedDrop(
          sharedAudio,
          episode,
          pairwiseRuns,
          intro.endSeconds,
          timeSeconds,
          getMeanDiagonalSimilarityForRefs,
        ) &&
        !audioWakesBeforeBoundary(episode, intro.mainEnd, boundaryFrame)
      );
    });
  if (!hasBackwardWindow && !hasForwardAudioCandidate) {
    return intro;
  }

  const frames = await extractVideoSceneProfile(
    mainFile,
    profileStartSeconds,
    profileDurationSeconds,
    runCommand,
  );
  if (!frames?.length) {
    return intro;
  }

  const candidates = collectNearbySceneChangeCandidates(
    frames,
    profileStartSeconds,
    anchorTimeSeconds,
  );
  if (!candidates.length) {
    return intro;
  }

  for (const candidate of candidates) {
    const boundaryFrame = secondToFrameAtOrAfter(candidate.timeSeconds);
    if (
      Math.abs(candidate.timeSeconds - intro.endSeconds) <= 1e-6 ||
      candidate.timeSeconds < minEndSeconds - 1e-6 ||
      candidate.timeSeconds > maxEndSeconds + 1e-6
    ) {
      continue;
    }

    if (candidate.distanceSeconds < 0) {
      if (candidate.frame.score >= END_SCENE_SNAP_BACKWARD_SCORE_MIN) {
        return setIntroEndSeconds(intro, candidate.timeSeconds);
      }
      continue;
    }

    if (
      canExtendForwardFromSharedEnd &&
      hasNearbySceneSnapQuietGap(episode, intro.endSeconds, candidate.timeSeconds) &&
      hasNearbySceneSnapSharedDrop(
        sharedAudio,
        episode,
        pairwiseRuns,
        intro.endSeconds,
        candidate.timeSeconds,
        getMeanDiagonalSimilarityForRefs,
      ) &&
      !audioWakesBeforeBoundary(episode, intro.mainEnd, boundaryFrame)
    ) {
      return setIntroEndSeconds(intro, candidate.timeSeconds);
    }
  }

  return intro;
}

function hasBleedSceneChangeSharedPlateau(
  sharedAudio,
  mainEpisode,
  pairwiseRuns,
  startSeconds,
  endSeconds,
  getMeanDiagonalSimilarityForRefs,
) {
  const shortPostWindow = getFrameWindowForSecondSpan(
    startSeconds,
    startSeconds + START_SCENE_SNAP_SHORT_POST_SECONDS,
    mainEpisode.frames.length,
  );
  const plateauWindow = getFrameWindowForSecondSpan(
    startSeconds + START_SCENE_SNAP_PLATEAU_DELAY_SECONDS,
    startSeconds + START_SCENE_SNAP_PLATEAU_DELAY_SECONDS + START_SCENE_SNAP_PLATEAU_SECONDS,
    mainEpisode.frames.length,
  );
  const prefixWindow = getFrameWindowForSecondSpan(
    endSeconds,
    startSeconds,
    mainEpisode.frames.length,
  );
  if (!shortPostWindow || !plateauWindow || !prefixWindow) {
    return false;
  }

  const shortPostSimilarity = getMeanDiagonalSimilarityForRefs(
    sharedAudio,
    pairwiseRuns,
    shortPostWindow.startFrame,
    shortPostWindow.endFrame,
  );
  const plateauSimilarity = getMeanDiagonalSimilarityForRefs(
    sharedAudio,
    pairwiseRuns,
    plateauWindow.startFrame,
    plateauWindow.endFrame,
  );
  const prefixSimilarity = getMeanDiagonalSimilarityForRefs(
    sharedAudio,
    pairwiseRuns,
    prefixWindow.startFrame,
    prefixWindow.endFrame,
  );
  if (
    shortPostSimilarity === null ||
    plateauSimilarity === null ||
    prefixSimilarity === null ||
    shortPostSimilarity < START_SCENE_SNAP_SHORT_SIMILARITY_MIN ||
    plateauSimilarity < START_SCENE_SNAP_PLATEAU_SIMILARITY_MIN
  ) {
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
  getSharedAudioBoundaryScore,
}) {
  const audioCandidates = new Map();
  const minStartFrame = secondToFrameAtOrAfter(
    intro.startSeconds + START_SCENE_SNAP_MIN_FORWARD_SECONDS,
  );
  const maxStartFrame = Math.min(
    secondToFrameAtOrAfter(intro.startSeconds + START_SCENE_SNAP_SEARCH_SECONDS),
    intro.mainEnd - minLen,
  );
  if (maxStartFrame < minStartFrame) {
    return audioCandidates;
  }

  const baseBoundary =
    getSharedAudioBoundaryScore(
      sharedAudio,
      pairwiseRuns,
      sharedAudio.mainStart,
      sharedAudio.mainEnd,
      'start',
    )?.score ?? Number.NEGATIVE_INFINITY;

  for (let candidateFrame = minStartFrame; candidateFrame <= maxStartFrame; candidateFrame += 1) {
    const candidateSeconds = frameToSeconds(candidateFrame);
    if (
      !hasBleedSceneChangeSharedPlateau(
        sharedAudio,
        mainEpisode,
        pairwiseRuns,
        candidateSeconds,
        intro.startSeconds,
        getMeanDiagonalSimilarityForRefs,
      )
    ) {
      continue;
    }

    const candidateBoundary = getSharedAudioBoundaryScore(
      sharedAudio,
      pairwiseRuns,
      candidateFrame,
      sharedAudio.mainEnd,
      'start',
    );
    if (
      !candidateBoundary ||
      candidateBoundary.score < baseBoundary - START_SCENE_SNAP_BOUNDARY_TOLERANCE
    ) {
      continue;
    }

    audioCandidates.set(candidateFrame, candidateBoundary.score);
  }

  return audioCandidates;
}

export async function trimIntroStartAtBleedSceneChange({
  intro,
  sharedAudio,
  mainEpisode,
  pairwiseRuns,
  minLen,
  mainFile,
  runCommand,
  getMeanDiagonalSimilarityForRefs,
  getSharedAudioBoundaryScore,
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
    getSharedAudioBoundaryScore,
  });
  if (!audioCandidates.size) {
    return intro;
  }

  const profileStartSeconds = Math.max(
    0,
    anchorTimeSeconds - START_SCENE_SNAP_PROFILE_MARGIN_SECONDS,
  );
  const profileDurationSeconds =
    START_SCENE_SNAP_SEARCH_SECONDS + START_SCENE_SNAP_PROFILE_MARGIN_SECONDS * 2;
  const frames = await extractVideoSceneProfile(
    mainFile,
    profileStartSeconds,
    profileDurationSeconds,
    runCommand,
  );
  if (!frames?.length) {
    return intro;
  }

  const candidates = collectNearbySceneChangeCandidates(
    frames,
    profileStartSeconds,
    anchorTimeSeconds,
    START_SCENE_SNAP_SEARCH_SECONDS,
  )
    .filter(
      (candidate) =>
        candidate.distanceSeconds >= START_SCENE_SNAP_MIN_FORWARD_SECONDS - 1e-6 &&
        candidate.distanceSeconds <= START_SCENE_SNAP_SEARCH_SECONDS + 1e-6 &&
        candidate.frame.score >= START_SCENE_SNAP_SCORE_MIN,
    )
    .sort((a, b) => a.timeSeconds - b.timeSeconds);
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
  if (
    postEnd <= runEnd ||
    postLevel < END_SILENCE_RMS_DB_THRESHOLD + 2.0 ||
    postLevel - silenceLevel < END_SILENCE_RECOVERY_DB
  ) {
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
  postFrames,
}) {
  if (runEnd - runStart < minSilenceFrames) {
    return bestEnd;
  }

  return (
    resolvePreJingleSilenceEnd(prefixRms, rmsDb, runStart, runEnd, minEnd, postFrames) ??
    bestEnd
  );
}

export function trimIntroEndAtPreJingleSilence(intro, mainEpisode, minLen) {
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
        postFrames,
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
      postFrames,
    });
  }

  return {
    ...intro,
    mainEnd: bestEnd,
    endSeconds: frameToSeconds(bestEnd),
    durationSeconds: round4(frameToSeconds(bestEnd) - intro.startSeconds),
  };
}

export async function postProcessIntroFromSharedAudio({
  sharedAudio,
  mainEpisode,
  pairwiseRuns,
  minLen,
  maxLen,
  mainFile,
  runCommand,
  getMeanDiagonalSimilarityForRefs,
  getSharedAudioBoundaryScore,
}) {
  const episode = withEpisodeMetrics(mainEpisode);
  let intro = {
    mainStart: sharedAudio.mainStart,
    mainEnd: sharedAudio.mainEnd,
    startSeconds: frameToSeconds(sharedAudio.mainStart),
    endSeconds: frameToSeconds(sharedAudio.mainEnd),
    durationSeconds: round4((sharedAudio.mainEnd - sharedAudio.mainStart) * FRAME_HOP_SECONDS),
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
    getSharedAudioBoundaryScore,
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
    getMeanDiagonalSimilarityForRefs,
  });

  if (!didTrimPreJingleSilence) {
    intro = extendIntroEndAtSilentStaticHold({
      intro,
      sharedAudio,
      mainEpisode: episode,
      boundaryContext,
    });

    intro = extendIntroEndAtFadeCutHold({
      intro,
      sharedAudio,
      mainEpisode: episode,
      boundaryContext,
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
    getMeanDiagonalSimilarityForRefs,
  });

  return formatSecondRange(intro.startSeconds, intro.endSeconds);
}
