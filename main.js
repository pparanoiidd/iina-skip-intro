const core = iina.core;
const event = iina.event;
const mpv = iina.mpv;
const overlay = iina.overlay;
const preferences = iina.preferences;
const console = iina.console;
const file = iina.file;
const iinaUtils = iina.utils;

const {
  SECTION_KIND_CREDITS,
  SECTION_KIND_RECAP,
  SECTION_KIND_SECTION,
  getChapterStart,
} = require('./detectors/shared.js');
const { detectSectionsFromChapterTitles } = require('./detectors/chapter-title.js');
const { detectSectionsFromChapterTiming } = require('./detectors/chapter-timing.js');
const { createAudioMatchDetector } = require('./detectors/audio-match.js');

const INTRO_PROMPT_LEAD_IN = 1;
const INTRO_PROMPT_AUTO_DISMISS_SECONDS = 15;
const INTRO_PROMPT_MIN_AUTO_DISMISS_SECONDS = 1;
const INTRO_PROMPT_MAX_AUTO_DISMISS_SECONDS = 60;
const SKIP_END_BUFFER_SECONDS = 1;
const SKIP_END_MIN_BUFFER_SECONDS = 0;
const SKIP_END_MAX_BUFFER_SECONDS = 10;
const DURATION_READ_DELAY_MS = 100;
const DETECTION_MIN_DURATION = 10 * 60;
const AUDIO_MATCH_MAX_DURATION = 90 * 60;
const AUDIO_MATCH_CHAPTER_SNAP_WINDOW = 3;
const PREF_DETECT_CHAPTER_TITLES = 'detect_chapter_titles';
const PREF_DETECT_INTROS = 'detect_intros';
const PREF_DETECT_AUDIO_MATCHING = 'detect_audio_matching';
const PREF_AUDIO_MATCH_PARSE_EPISODE_NUMBERS = 'audio_match_parse_episode_numbers';
const PREF_DETECT_CHAPTER_TIMING = 'detect_chapter_timing';
const PREF_DETECT_RECAPS = 'detect_recaps';
const PREF_DETECT_CREDITS = 'detect_credits';
const PREF_POPUP_AUTO_DISMISS_SECONDS = 'popup_auto_dismiss_seconds';
const PREF_SKIP_END_BUFFER_SECONDS = 'skip_end_buffer_seconds';

let overlayReady = false;
let overlayVisible = false;
let overlayInitialized = false;
let handlersRegistered = false;
let detectedSections = [];
let currentOverlaySection = null;
let dismissedSectionIds = Object.create(null);
let detectionRunId = 0;

function log(message) {
  console.log(message);
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

const audioMatchDetector = createAudioMatchDetector({
  mpv: mpv,
  file: file,
  utils: iinaUtils,
  log: log,
  delay: delay,
});
const detectSectionFromAudioMatch = audioMatchDetector.detectSectionFromAudioMatch;

function getPosition() {
  const position = mpv.getNumber('time-pos');
  return typeof position === 'number' && isFinite(position) ? position : null;
}

function getDuration() {
  const duration = mpv.getNumber('duration');
  return typeof duration === 'number' && isFinite(duration) && duration > 0 ? duration : null;
}

function isDurationLongEnoughForDetection(duration) {
  return typeof duration === 'number' && isFinite(duration) && duration >= DETECTION_MIN_DURATION;
}

function isDurationShortEnoughForAudioMatching(duration) {
  return typeof duration === 'number' && isFinite(duration) && duration <= AUDIO_MATCH_MAX_DURATION;
}

function getBooleanPreference(key, fallbackValue) {
  if (!preferences || typeof preferences.get !== 'function') {
    return fallbackValue;
  }

  const value = preferences.get(key);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return fallbackValue;
}

function getNumberPreference(key, fallbackValue) {
  if (!preferences || typeof preferences.get !== 'function') {
    return fallbackValue;
  }

  const value = preferences.get(key);
  if (typeof value === 'number' && isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (isFinite(parsed)) return parsed;
  }
  return fallbackValue;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isRecapDetectionEnabled() {
  return getBooleanPreference(PREF_DETECT_RECAPS, false);
}

function isIntroDetectionEnabled() {
  return getBooleanPreference(PREF_DETECT_INTROS, true);
}

function isCreditDetectionEnabled() {
  return getBooleanPreference(PREF_DETECT_CREDITS, true);
}

function isChapterTitleDetectionEnabled() {
  return getBooleanPreference(PREF_DETECT_CHAPTER_TITLES, true);
}

function isAudioMatchingEnabled() {
  return getBooleanPreference(PREF_DETECT_AUDIO_MATCHING, true);
}

function isAudioMatchEpisodeParsingEnabled() {
  return getBooleanPreference(PREF_AUDIO_MATCH_PARSE_EPISODE_NUMBERS, true);
}

function isChapterTimingDetectionEnabled() {
  return getBooleanPreference(PREF_DETECT_CHAPTER_TIMING, false);
}

function getPopupAutoDismissSeconds() {
  return clampNumber(
    getNumberPreference(PREF_POPUP_AUTO_DISMISS_SECONDS, INTRO_PROMPT_AUTO_DISMISS_SECONDS),
    INTRO_PROMPT_MIN_AUTO_DISMISS_SECONDS,
    INTRO_PROMPT_MAX_AUTO_DISMISS_SECONDS,
  );
}

function getSkipEndBufferSeconds() {
  return clampNumber(
    getNumberPreference(PREF_SKIP_END_BUFFER_SECONDS, SKIP_END_BUFFER_SECONDS),
    SKIP_END_MIN_BUFFER_SECONDS,
    SKIP_END_MAX_BUFFER_SECONDS,
  );
}

function hasEnabledDetectionMethod(options) {
  return !!(
    options &&
    ((options.detectChapterTitles &&
      (options.detectIntros || options.detectRecaps || options.detectCredits)) ||
      options.detectAudioMatching ||
      options.detectChapterTiming)
  );
}

function getSectionTitles(sectionGroup) {
  if (!sectionGroup || !Array.isArray(sectionGroup.sections)) return [];

  const titles = [];
  for (let i = 0; i < sectionGroup.sections.length; i++) {
    const section = sectionGroup.sections[i];
    for (let j = 0; j < section.titles.length; j++) {
      titles.push(section.titles[j]);
    }
  }
  return titles;
}

function getSectionSources(sectionGroup) {
  if (!sectionGroup || !Array.isArray(sectionGroup.sections)) return [];

  const sources = [];
  for (let i = 0; i < sectionGroup.sections.length; i++) {
    const source = sectionGroup.sections[i].source;
    if (sources.indexOf(source) === -1) {
      sources.push(source);
    }
  }
  return sources;
}

function getSkipLabel(sectionGroup) {
  if (!sectionGroup) return 'Skip Intro';
  if (sectionGroup.sections.length > 1) return 'Skip Opening';

  const kind = sectionGroup.sections[0].kind;
  if (kind === SECTION_KIND_CREDITS) return 'Skip Credits';
  if (kind === SECTION_KIND_RECAP) return 'Skip Recap';
  if (kind === SECTION_KIND_SECTION) return 'Skip Opening';
  return 'Skip Intro';
}

function getSectionDescription(sectionGroup) {
  if (!sectionGroup) return 'section';
  if (sectionGroup.sections.length > 1) return 'opening';

  const kind = sectionGroup.sections[0].kind;
  if (kind === SECTION_KIND_CREDITS) return 'credits';
  if (kind === SECTION_KIND_RECAP) return 'recap';
  if (kind === SECTION_KIND_SECTION) return 'opening';
  return 'intro';
}

function getNearestChapterStartInWindow(chapters, target, maxDistance) {
  if (!Array.isArray(chapters) || typeof target !== 'number' || !isFinite(target)) return null;

  let nearestStart = null;
  let nearestDistance = null;
  for (let i = 0; i < chapters.length; i++) {
    const chapterStart = getChapterStart(chapters[i]);
    if (chapterStart === null) continue;

    const distance = Math.abs(chapterStart - target);
    if (distance <= maxDistance && (nearestDistance === null || distance < nearestDistance)) {
      nearestStart = chapterStart;
      nearestDistance = distance;
    }
  }

  return nearestStart;
}

function snapAudioSectionGroupToChapters(sectionGroup, chapters) {
  if (!sectionGroup || !Array.isArray(sectionGroup.sections) || !sectionGroup.sections.length) {
    return sectionGroup;
  }

  const nearestStart = getNearestChapterStartInWindow(
    chapters,
    sectionGroup.start,
    AUDIO_MATCH_CHAPTER_SNAP_WINDOW,
  );
  const nearestEnd = getNearestChapterStartInWindow(
    chapters,
    sectionGroup.end,
    AUDIO_MATCH_CHAPTER_SNAP_WINDOW,
  );
  const snappedStart = nearestStart === null ? sectionGroup.start : nearestStart;
  const snappedEnd = nearestEnd === null ? sectionGroup.end : nearestEnd;

  if (snappedStart === sectionGroup.start && snappedEnd === sectionGroup.end) {
    return sectionGroup;
  }
  if (snappedEnd <= snappedStart) {
    return sectionGroup;
  }

  log(
    'Snapped audio intro to chapter marker(s): ' +
      sectionGroup.start.toFixed(2) +
      's-' +
      sectionGroup.end.toFixed(2) +
      's -> ' +
      snappedStart.toFixed(2) +
      's-' +
      snappedEnd.toFixed(2) +
      's',
  );

  return Object.assign({}, sectionGroup, {
    start: snappedStart,
    end: snappedEnd,
    sections: sectionGroup.sections.map(function (currentSection, index) {
      if (index !== 0) return currentSection;
      return Object.assign({}, currentSection, {
        start: snappedStart,
        end: snappedEnd,
      });
    }),
  });
}

async function detectCurrentSections() {
  const runId = ++detectionRunId;
  const options = {
    detectChapterTitles: isChapterTitleDetectionEnabled(),
    detectAudioMatching: isAudioMatchingEnabled(),
    parseAudioMatchEpisodeNumbers: isAudioMatchEpisodeParsingEnabled(),
    detectChapterTiming: isChapterTimingDetectionEnabled(),
    detectIntros: isIntroDetectionEnabled(),
    detectRecaps: isRecapDetectionEnabled(),
    detectCredits: isCreditDetectionEnabled(),
  };

  if (!hasEnabledDetectionMethod(options)) {
    detectedSections = [];
    log('Skipping intro detection: all detection methods are disabled');
    updateOverlay();
    return;
  }

  let chapters = [];
  let duration = null;

  try {
    await delay(DURATION_READ_DELAY_MS);
    if (runId !== detectionRunId) return;
    duration = getDuration();
    if (!isDurationLongEnoughForDetection(duration)) {
      detectedSections = [];
      log(
        'Skipping intro detection: duration is unknown or below ' +
          Math.round(DETECTION_MIN_DURATION / 60) +
          ' minutes',
      );
      updateOverlay();
      return;
    }
    chapters = core.getChapters();
    detectedSections = detectSectionsFromChapterTitles(chapters, duration, options);
  } catch (error) {
    detectedSections = [];
    log('Chapter title intro detection failed: ' + error);
  }

  if (runId !== detectionRunId) return;

  if (
    !detectedSections.length &&
    options.detectAudioMatching &&
    isDurationShortEnoughForAudioMatching(duration)
  ) {
    try {
      const audioSectionGroup = await detectSectionFromAudioMatch(options);
      if (runId !== detectionRunId) return;
      detectedSections = audioSectionGroup
        ? [snapAudioSectionGroupToChapters(audioSectionGroup, chapters)]
        : [];
    } catch (error) {
      if (runId !== detectionRunId) return;
      detectedSections = [];
      log('Audio intro detection failed: ' + error);
    }
  } else if (!detectedSections.length && options.detectAudioMatching) {
    log(
      'Skipping audio intro detection: duration is above ' +
        Math.round(AUDIO_MATCH_MAX_DURATION / 60) +
        ' minutes',
    );
  }

  if (!detectedSections.length) {
    try {
      detectedSections = detectSectionsFromChapterTiming(chapters, duration, options);
    } catch (error) {
      detectedSections = [];
      log('Chapter timing intro detection failed: ' + error);
    }
  }

  if (!detectedSections.length) {
    log('No skip sections detected');
    updateOverlay();
    return;
  }

  for (let i = 0; i < detectedSections.length; i++) {
    const sectionGroup = detectedSections[i];
    log(
      'Detected ' +
        getSectionDescription(sectionGroup) +
        ' from ' +
        sectionGroup.start.toFixed(2) +
        's to ' +
        sectionGroup.end.toFixed(2) +
        's via ' +
        getSectionSources(sectionGroup).join(', ') +
        ': ' +
        getSectionTitles(sectionGroup).join(', '),
    );
  }

  updateOverlay();
}

function isPlaybackPaused() {
  return !!(core.status && core.status.paused);
}

function dismissOverlay() {
  if (currentOverlaySection) {
    dismissedSectionIds[currentOverlaySection.id] = true;
  }
  setOverlayVisible(false, null);
}

function registerHandlers() {
  if (handlersRegistered) return;
  handlersRegistered = true;

  overlay.onMessage('skip', function () {
    if (!currentOverlaySection) {
      log('Skip requested with no detected section');
      dismissOverlay();
      return;
    }

    const bufferSeconds = getSkipEndBufferSeconds();
    const seekTarget = Math.max(
      currentOverlaySection.start,
      currentOverlaySection.end - bufferSeconds,
    );
    log('Skip requested - seeking to ' + seekTarget.toFixed(2) + 's');
    core.seekTo(seekTarget);
    dismissOverlay();
  });

  overlay.onMessage('autoDismiss', function () {
    if (!overlayVisible || !currentOverlaySection) return;

    log('Auto dismissed after ' + getPopupAutoDismissSeconds() + 's');
    dismissOverlay();
  });

  overlay.onMessage('error', function (msg) {
    log('Overlay error: ' + msg);
  });
}

function initializeOverlay() {
  if (overlayInitialized || !core.window.loaded) return;
  overlayInitialized = true;
  log('Initializing overlay');

  overlay.loadFile('overlay.html');
}

function sendState(visible, sectionGroup) {
  const autoDismissSeconds = getPopupAutoDismissSeconds();
  overlayVisible = visible;
  currentOverlaySection = visible ? sectionGroup : null;
  overlay.postMessage('state', {
    visible: visible,
    sectionId: sectionGroup ? sectionGroup.id : null,
    autoDismissMs: autoDismissSeconds * 1000,
    playbackPaused: isPlaybackPaused(),
    skipLabel: getSkipLabel(sectionGroup),
  });
}

function setOverlayVisible(visible, sectionGroup) {
  sendState(visible, sectionGroup);
  overlay.setClickable(visible);
}

function getActiveSection(position) {
  for (let i = 0; i < detectedSections.length; i++) {
    const sectionGroup = detectedSections[i];
    if (dismissedSectionIds[sectionGroup.id]) continue;

    if (
      position >= Math.max(0, sectionGroup.start - INTRO_PROMPT_LEAD_IN) &&
      position < sectionGroup.end
    ) {
      return sectionGroup;
    }
  }

  return null;
}

function updateOverlay(position) {
  if (!overlayReady) return;
  if (typeof position !== 'number') {
    position = getPosition();
  }
  if (typeof position !== 'number' || !isFinite(position)) {
    return;
  }

  const activeSection = getActiveSection(position);
  const show = !!activeSection;
  const sectionChanged =
    (!currentOverlaySection && !!activeSection) ||
    (!!currentOverlaySection && !activeSection) ||
    (!!currentOverlaySection && !!activeSection && currentOverlaySection.id !== activeSection.id);
  if (show === overlayVisible && !sectionChanged) return;

  log(
    (show ? 'Showing' : 'Hiding') +
      ' overlay at ' +
      position.toFixed(2) +
      's' +
      (show ? ' for ' + getSectionDescription(activeSection) : ''),
  );
  setOverlayVisible(show, activeSection);
}

function resetState() {
  detectionRunId++;
  dismissedSectionIds = Object.create(null);
  detectedSections = [];
  currentOverlaySection = null;
  if (overlayReady) {
    setOverlayVisible(false, null);
    return;
  }
  overlayVisible = false;
}

event.on('iina.window-loaded', function () {
  log('Window loaded');
  initializeOverlay();
});

event.on('iina.plugin-overlay-loaded', function () {
  log('Overlay view loaded');
  overlayReady = true;
  overlay.show();
  overlay.setClickable(false);
  registerHandlers();
  updateOverlay();
});

event.on('mpv.file-loaded', function () {
  log('File loaded');
  resetState();
  detectCurrentSections();
  updateOverlay();
});

event.on('mpv.end-file', function () {
  resetState();
});

event.on('mpv.time-pos.changed', function () {
  updateOverlay();
});

event.on('mpv.pause.changed', function () {
  if (overlayReady && overlayVisible) {
    overlay.postMessage('playbackPaused', isPlaybackPaused());
  }
});

// Attempt init immediately in case window is already loaded
initializeOverlay();
