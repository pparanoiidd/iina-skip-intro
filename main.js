const core = iina.core;
const event = iina.event;
const mpv = iina.mpv;
const overlay = iina.overlay;
const preferences = iina.preferences;
const console = iina.console;
const file = iina.file;
const iinaUtils = iina.utils;

const {
  SECTION_KIND_RECAP,
  SECTION_KIND_SECTION,
} = require('./detectors/shared.js');
const {
  detectSectionsFromChapterTitles,
} = require('./detectors/chapter-title.js');
const {
  detectSectionsFromChapterTiming,
} = require('./detectors/chapter-timing.js');
const {
  createAudioMatchDetector,
} = require('./detectors/audio-match.js');

const INTRO_PROMPT_LEAD_IN = 1;
const INTRO_PROMPT_AUTO_DISMISS_MS = 10000;
const PREF_DETECT_CHAPTER_TITLES = 'detect_chapter_titles';
const PREF_DETECT_AUDIO_MATCHING = 'detect_audio_matching';
const PREF_DETECT_CHAPTER_TIMING = 'detect_chapter_timing';
const PREF_PROGRESS_INDICATOR_STYLE = 'progress_indicator_style';
const PREF_DETECT_RECAPS = 'detect_recaps';
const PROGRESS_INDICATOR_FULL = 'full';
const PROGRESS_INDICATOR_BAR = 'bar';

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

function isRecapDetectionEnabled() {
  return getBooleanPreference(PREF_DETECT_RECAPS, false);
}

function isChapterTitleDetectionEnabled() {
  return getBooleanPreference(PREF_DETECT_CHAPTER_TITLES, true);
}

function isAudioMatchingEnabled() {
  return getBooleanPreference(PREF_DETECT_AUDIO_MATCHING, true);
}

function isChapterTimingDetectionEnabled() {
  return getBooleanPreference(PREF_DETECT_CHAPTER_TIMING, false);
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
  if (sectionGroup.sections.length > 1) return 'Skip Sections';

  const kind = sectionGroup.sections[0].kind;
  if (kind === SECTION_KIND_RECAP) return 'Skip Recap';
  if (kind === SECTION_KIND_SECTION) return 'Skip Section';
  return 'Skip Intro';
}

function getSectionDescription(sectionGroup) {
  if (!sectionGroup) return 'section';
  if (sectionGroup.sections.length > 1) return 'sections';

  const kind = sectionGroup.sections[0].kind;
  if (kind === SECTION_KIND_RECAP) return 'recap';
  if (kind === SECTION_KIND_SECTION) return 'section';
  return 'intro';
}

async function detectCurrentSections() {
  const runId = ++detectionRunId;
  const options = {
    detectChapterTitles: isChapterTitleDetectionEnabled(),
    detectAudioMatching: isAudioMatchingEnabled(),
    detectChapterTiming: isChapterTimingDetectionEnabled(),
    detectRecaps: isRecapDetectionEnabled(),
  };
  let chapters = [];
  let duration = null;

  try {
    duration = getDuration();
    chapters = core.getChapters();
    detectedSections = detectSectionsFromChapterTitles(chapters, duration, options);
  } catch (error) {
    detectedSections = [];
    log('Chapter title intro detection failed: ' + error);
  }

  if (runId !== detectionRunId) return;

  if (!detectedSections.length && options.detectAudioMatching) {
    try {
      const audioSectionGroup = await detectSectionFromAudioMatch();
      if (runId !== detectionRunId) return;
      detectedSections = audioSectionGroup ? [audioSectionGroup] : [];
    } catch (error) {
      if (runId !== detectionRunId) return;
      detectedSections = [];
      log('Audio intro detection failed: ' + error);
    }
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

function getProgressIndicatorStyle() {
  if (!preferences || typeof preferences.get !== 'function') {
    return PROGRESS_INDICATOR_FULL;
  }

  const style = preferences.get(PREF_PROGRESS_INDICATOR_STYLE);
  return style === PROGRESS_INDICATOR_BAR ? PROGRESS_INDICATOR_BAR : PROGRESS_INDICATOR_FULL;
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

    log('Skip requested - seeking to ' + currentOverlaySection.end.toFixed(2) + 's');
    core.seekTo(currentOverlaySection.end);
    dismissOverlay();
  });

  overlay.onMessage('autoDismiss', function () {
    if (!overlayVisible || !currentOverlaySection) return;

    log('Auto dismissed after ' + INTRO_PROMPT_AUTO_DISMISS_MS / 1000 + 's');
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
  overlayVisible = visible;
  currentOverlaySection = visible ? sectionGroup : null;
  overlay.postMessage('state', {
    visible: visible,
    autoDismissMs: INTRO_PROMPT_AUTO_DISMISS_MS,
    playbackPaused: isPlaybackPaused(),
    progressIndicatorStyle: getProgressIndicatorStyle(),
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
