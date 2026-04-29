const core = iina.core;
const event = iina.event;
const mpv = iina.mpv;
const overlay = iina.overlay;
const preferences = iina.preferences;
const input = iina.input;
const console = iina.console;
const file = iina.file;
const iinaUtils = iina.utils;

const {
  SECTION_KIND_INTRO,
  SECTION_KIND_CREDITS,
  SECTION_KIND_RECAP,
  SECTION_KIND_SECTION,
  SECTION_SOURCE_AUDIO_FINGERPRINT,
  SECTION_SOURCE_TITLE,
  getLocalFilePath,
  getChapterStart,
  isVideoFilePath,
  parseSeasonEpisode,
} = require('./detectors/shared.js');
const { detectSectionsFromChapterTitles } = require('./detectors/chapter-title.js');
const { detectSectionsFromChapterTiming } = require('./detectors/chapter-timing.js');
const { createAudioMatchDetector } = require('./detectors/audio-match.js');

const INTRO_PROMPT_LEAD_IN = 1;
const AUTO_SKIP_START_DELAY_SECONDS = 0;
const AUTO_SKIP_MIN_START_DELAY_SECONDS = 0;
const AUTO_SKIP_MAX_START_DELAY_SECONDS = 10;
const AUTO_SKIP_STATUS_LEAD_IN_SECONDS = 2;
const AUTO_SKIP_STATUS_AFTER_SECONDS = 2;
const INTRO_PROMPT_AUTO_DISMISS_SECONDS = 15;
const INTRO_PROMPT_MIN_AUTO_DISMISS_SECONDS = 5;
const INTRO_PROMPT_MAX_AUTO_DISMISS_SECONDS = 20;
const SKIP_END_BUFFER_SECONDS = 1;
const SKIP_END_MIN_BUFFER_SECONDS = 0;
const SKIP_END_MAX_BUFFER_SECONDS = 10;
const DURATION_READ_DELAY_MS = 500;
const DETECTION_MIN_DURATION = 10 * 60;
const MOVIE_MIN_DURATION = 90 * 60;
const AUDIO_MATCH_CHAPTER_SNAP_WINDOW = 3;

const PREF_DETECT_CHAPTER_TITLES = 'detect_chapter_titles';
const PREF_DETECT_INTROS = 'detect_intros';
const PREF_DETECT_AUDIO_MATCHING = 'detect_audio_matching';
const PREF_AUDIO_MATCH_PARSE_EPISODE_NUMBERS = 'audio_match_parse_episode_numbers';
const PREF_DETECT_CHAPTER_TIMING = 'detect_chapter_timing';
const PREF_DETECT_RECAPS = 'detect_recaps';
const PREF_DETECT_CREDITS = 'detect_credits';
const PREF_AUTO_SKIP_TITLE_INTROS = 'auto_skip_title_intros';
const PREF_AUTO_SKIP_TITLE_RECAPS = 'auto_skip_title_recaps';
const PREF_AUTO_SKIP_TITLE_CREDITS = 'auto_skip_title_credits';
const PREF_AUTO_SKIP_AUDIO_MATCHING = 'auto_skip_audio_matching';
const PREF_AUTO_SKIP_START_DELAY_SECONDS = 'auto_skip_start_delay_seconds';
const PREF_SHOW_AUTO_SKIP_STATUS = 'show_auto_skip_status';
const PREF_AUTO_SKIP_FIRST_EPISODE_OF_SEASON = 'auto_skip_first_episode_of_season';
const PREF_POPUP_AUTO_DISMISS_SECONDS = 'popup_auto_dismiss_seconds';
const PREF_SKIP_END_BUFFER_SECONDS = 'skip_end_buffer_seconds';
const PREF_SKIP_KEY_BINDING = 'skip_key_binding';
const PREF_POPUP_BUTTON_GREY = 'popup_button_grey';

let overlayReady = false;
let overlayVisible = false;
let overlayMode = null;
let overlayInitialized = false;
let handlersRegistered = false;
let detectedSections = [];
let currentOverlaySection = null;
let autoSkipStatusSectionId = null;
let autoSkipStatusPhase = null;
let autoSkipStatusHideTimer = null;
let dismissedSectionIds = Object.create(null);
let detectionRunId = 0;
let shownAudioDependencyWarningKey = null;
let registeredSkipKeyBinding = null;

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
const getAudioMatchDependencyStatus = audioMatchDetector.getAudioMatchDependencyStatus;

function getPosition() {
  const position = mpv.getNumber('time-pos');
  return typeof position === 'number' && isFinite(position) ? position : null;
}

function getDuration() {
  const duration = mpv.getNumber('duration');
  return typeof duration === 'number' && isFinite(duration) && duration > 0 ? duration : null;
}

function getCurrentMediaPath() {
  try {
    const path = mpv.getString('path');
    return typeof path === 'string' && path ? getLocalFilePath(path) || path : null;
  } catch (error) {
    return null;
  }
}

function isDurationLongEnoughForDetection(duration) {
  return typeof duration === 'number' && isFinite(duration) && duration >= DETECTION_MIN_DURATION;
}

function isMovieDuration(duration) {
  return typeof duration === 'number' && isFinite(duration) && duration > MOVIE_MIN_DURATION;
}

function getDetectionOptionsForDuration(options, duration) {
  if (!isMovieDuration(duration)) return options;

  return {
    detectChapterTitles: options.detectChapterTitles,
    detectAudioMatching: false,
    parseAudioMatchEpisodeNumbers: options.parseAudioMatchEpisodeNumbers,
    detectChapterTiming: false,
    detectIntros: false,
    detectRecaps: false,
    detectCredits: options.detectCredits,
  };
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

function getStringPreference(key, fallbackValue) {
  if (!preferences || typeof preferences.get !== 'function') {
    return fallbackValue;
  }

  const value = preferences.get(key);
  return typeof value === 'string' ? value : fallbackValue;
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
  return getBooleanPreference(PREF_DETECT_AUDIO_MATCHING, false);
}

function isAudioMatchEpisodeParsingEnabled() {
  return getBooleanPreference(PREF_AUDIO_MATCH_PARSE_EPISODE_NUMBERS, true);
}

function isChapterTimingDetectionEnabled() {
  return getBooleanPreference(PREF_DETECT_CHAPTER_TIMING, false);
}

function isTitleIntroAutoSkipEnabled() {
  return getBooleanPreference(PREF_AUTO_SKIP_TITLE_INTROS, false);
}

function isTitleRecapAutoSkipEnabled() {
  return getBooleanPreference(PREF_AUTO_SKIP_TITLE_RECAPS, false);
}

function isTitleCreditsAutoSkipEnabled() {
  return getBooleanPreference(PREF_AUTO_SKIP_TITLE_CREDITS, false);
}

function isAudioMatchingAutoSkipEnabled() {
  return getBooleanPreference(PREF_AUTO_SKIP_AUDIO_MATCHING, false);
}

function getDetectionOptionsFromPreferences() {
  return {
    detectChapterTitles: isChapterTitleDetectionEnabled(),
    detectAudioMatching: isAudioMatchingEnabled(),
    parseAudioMatchEpisodeNumbers: isAudioMatchEpisodeParsingEnabled(),
    detectChapterTiming: isChapterTimingDetectionEnabled(),
    detectIntros: isIntroDetectionEnabled(),
    detectRecaps: isRecapDetectionEnabled(),
    detectCredits: isCreditDetectionEnabled(),
  };
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

function getAutoSkipStartDelaySeconds() {
  return clampNumber(
    getNumberPreference(PREF_AUTO_SKIP_START_DELAY_SECONDS, AUTO_SKIP_START_DELAY_SECONDS),
    AUTO_SKIP_MIN_START_DELAY_SECONDS,
    AUTO_SKIP_MAX_START_DELAY_SECONDS,
  );
}

function shouldShowAutoSkipStatus() {
  return getBooleanPreference(PREF_SHOW_AUTO_SKIP_STATUS, true);
}

function shouldAutoSkipFirstEpisodeOfSeason() {
  return getBooleanPreference(PREF_AUTO_SKIP_FIRST_EPISODE_OF_SEASON, true);
}

function getPopupButtonStyle() {
  return getBooleanPreference(PREF_POPUP_BUTTON_GREY, false) ? 'grey' : 'white';
}

function getSkipKeyBinding() {
  return getStringPreference(PREF_SKIP_KEY_BINDING, '').trim();
}

function formatAudioDependencyName(dependency) {
  if (dependency === 'node') return 'Node.js';
  if (dependency === 'ffmpeg') return 'ffmpeg';
  return dependency;
}

function formatAudioDependencyList(missingDependencies) {
  const labels = missingDependencies.map(formatAudioDependencyName);
  if (labels.length <= 1) return labels[0] || '';
  return labels.slice(0, -1).join(', ') + ' and ' + labels[labels.length - 1];
}

function showAudioDependencyWarning(missingDependencies) {
  if (!Array.isArray(missingDependencies) || !missingDependencies.length) return;

  const key = missingDependencies.slice().sort().join(',');
  if (shownAudioDependencyWarningKey === key) return;
  shownAudioDependencyWarningKey = key;

  const message =
    'Skip Intro: audio fingerprint detection needs ' +
    formatAudioDependencyList(missingDependencies) +
    '. See README.md for setup instructions, or disable audio matching in settings to hide this.';
  log(message);
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

function getSectionLabelNoun(sectionGroup) {
  if (!sectionGroup) return 'Intro';
  if (sectionGroup.sections.length > 1) return 'Opening';

  const kind = sectionGroup.sections[0].kind;
  if (kind === SECTION_KIND_CREDITS) return 'Credits';
  if (kind === SECTION_KIND_RECAP) return 'Recap';
  if (kind === SECTION_KIND_SECTION) return 'Opening';
  return 'Intro';
}

function getAutoSkipPendingLabel(sectionGroup) {
  return 'Skipping ' + getSectionLabelNoun(sectionGroup);
}

function getAutoSkipCompleteLabel(sectionGroup) {
  return getSectionLabelNoun(sectionGroup) + ' Skipped';
}

function getAutoSkipSettingsFromPreferences() {
  return {
    titleIntros: isTitleIntroAutoSkipEnabled(),
    titleRecaps: isTitleRecapAutoSkipEnabled(),
    titleCredits: isTitleCreditsAutoSkipEnabled(),
    audioMatching: isAudioMatchingAutoSkipEnabled(),
    startDelaySeconds: getAutoSkipStartDelaySeconds(),
    showStatus: shouldShowAutoSkipStatus(),
    autoSkipFirstEpisodeOfSeason: shouldAutoSkipFirstEpisodeOfSeason(),
  };
}

function getAutoSkipSettingForTitleKind(kind, settings) {
  if (kind === SECTION_KIND_CREDITS) return settings.titleCredits;
  if (kind === SECTION_KIND_RECAP) return settings.titleRecaps;
  return settings.titleIntros;
}

function resolveAutoSkipForSection(sectionGroup, settings) {
  if (!sectionGroup || !Array.isArray(sectionGroup.sections) || !sectionGroup.sections.length) {
    return false;
  }

  for (let i = 0; i < sectionGroup.sections.length; i++) {
    const section = sectionGroup.sections[i];
    if (section.source === SECTION_SOURCE_AUDIO_FINGERPRINT) {
      if (settings.audioMatching) return true;
      continue;
    }
    if (
      section.source === SECTION_SOURCE_TITLE &&
      getAutoSkipSettingForTitleKind(section.kind, settings)
    ) {
      return true;
    }
  }

  return false;
}

function isIntroLikeSectionGroup(sectionGroup) {
  if (!sectionGroup || !Array.isArray(sectionGroup.sections) || !sectionGroup.sections.length) {
    return false;
  }

  for (let i = 0; i < sectionGroup.sections.length; i++) {
    const kind = sectionGroup.sections[i].kind;
    if (kind === SECTION_KIND_INTRO || kind === SECTION_KIND_SECTION) {
      return true;
    }
  }

  return false;
}

function shouldDisableIntroAutoSkipForFirstEpisodeOfSeason(sectionGroup, mediaPath, settings) {
  if (settings.autoSkipFirstEpisodeOfSeason || !isIntroLikeSectionGroup(sectionGroup)) return false;

  const parsed = parseSeasonEpisode(mediaPath);
  return !!(parsed && !parsed.isSpecial && parsed.episode === 1);
}

function addAutoSkipState(sectionGroups, mediaPath) {
  const settings = getAutoSkipSettingsFromPreferences();
  return sectionGroups.map(function (sectionGroup) {
    let autoSkip = resolveAutoSkipForSection(sectionGroup, settings);
    if (
      autoSkip &&
      shouldDisableIntroAutoSkipForFirstEpisodeOfSeason(sectionGroup, mediaPath, settings)
    ) {
      log('Auto-skip disabled: not skipping intro for first episode of the season');
      autoSkip = false;
    }
    return Object.assign({}, sectionGroup, {
      autoSkip: autoSkip,
      autoSkipStartDelaySeconds: autoSkip ? settings.startDelaySeconds : 0,
      showAutoSkipStatus: autoSkip && settings.showStatus,
    });
  });
}

function shouldAutoSkipSection(sectionGroup) {
  return !!(sectionGroup && sectionGroup.autoSkip);
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

async function getDetectionContext(runId) {
  await delay(DURATION_READ_DELAY_MS);
  if (runId !== detectionRunId) return null;

  const currentPath = getCurrentMediaPath();
  if (!isVideoFilePath(currentPath)) {
    return {
      skipMessage: 'Skipping intro detection: current file is not a supported video file',
    };
  }

  const duration = getDuration();
  if (!isDurationLongEnoughForDetection(duration)) {
    return {
      skipMessage:
        'Skipping intro detection: duration is unknown or below ' +
        Math.round(DETECTION_MIN_DURATION / 60) +
        ' minutes',
    };
  }

  let chapters = [];
  try {
    chapters = core.getChapters();
  } catch (error) {
    log('Chapter lookup failed: ' + error);
  }

  return {
    chapters: chapters,
    duration: duration,
    mediaPath: currentPath,
  };
}

function detectFromChapterTitles(context, options) {
  try {
    return detectSectionsFromChapterTitles(context.chapters, context.duration, options);
  } catch (error) {
    log('Chapter title intro detection failed: ' + error);
    return [];
  }
}

async function detectFromAudioMatch(context, options, runId) {
  if (!options.detectAudioMatching) return [];

  try {
    const dependencyStatus = await getAudioMatchDependencyStatus();
    if (runId !== detectionRunId) return null;

    if (!dependencyStatus.ok) {
      showAudioDependencyWarning(dependencyStatus.missing);
      return [];
    }

    const audioSectionGroup = await detectSectionFromAudioMatch(options);
    if (runId !== detectionRunId) return null;

    return audioSectionGroup
      ? [snapAudioSectionGroupToChapters(audioSectionGroup, context.chapters)]
      : [];
  } catch (error) {
    if (runId !== detectionRunId) return null;
    log('Audio intro detection failed: ' + error);
    return [];
  }
}

function detectFromChapterTiming(context, options) {
  try {
    return detectSectionsFromChapterTiming(context.chapters, context.duration, options);
  } catch (error) {
    log('Chapter timing intro detection failed: ' + error);
    return [];
  }
}

function finishDetection(sections, emptyMessage, context) {
  detectedSections = addAutoSkipState(
    Array.isArray(sections) ? sections : [],
    context && context.mediaPath,
  );

  if (emptyMessage) {
    log(emptyMessage);
    updateOverlay();
    return;
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

async function detectCurrentSections() {
  const runId = ++detectionRunId;
  const initialOptions = getDetectionOptionsFromPreferences();

  if (!hasEnabledDetectionMethod(initialOptions)) {
    finishDetection([], 'Skipping intro detection: all detection methods are disabled');
    return;
  }

  const context = await getDetectionContext(runId);
  if (!context) return;
  if (context.skipMessage) {
    finishDetection([], context.skipMessage, context);
    return;
  }

  const options = getDetectionOptionsForDuration(initialOptions, context.duration);
  if (!hasEnabledDetectionMethod(options)) {
    finishDetection(
      [],
      'Skipping intro detection: movie-length media only detects credits from chapter titles',
      context,
    );
    return;
  }

  let sections = detectFromChapterTitles(context, options);
  if (!sections.length) {
    sections = await detectFromAudioMatch(context, options, runId);
    if (sections === null) return;
  }
  if (!sections.length) {
    sections = detectFromChapterTiming(context, options);
  }

  finishDetection(sections, null, context);
}

function isPlaybackPaused() {
  return !!(core.status && core.status.paused);
}

function clearAutoSkipStatusTimer() {
  if (autoSkipStatusHideTimer === null) return;
  clearTimeout(autoSkipStatusHideTimer);
  autoSkipStatusHideTimer = null;
}

function dismissOverlay() {
  if (currentOverlaySection) {
    dismissedSectionIds[currentOverlaySection.id] = true;
  }
  setOverlayVisible(false, null);
}

function skipSection(sectionGroup, reason, options) {
  if (!sectionGroup) {
    log('Skip requested with no detected section');
    dismissOverlay();
    return;
  }

  const bufferSeconds = getSkipEndBufferSeconds();
  const seekTarget = Math.max(sectionGroup.start, sectionGroup.end - bufferSeconds);
  log(reason + ' - seeking to ' + seekTarget.toFixed(2) + 's');
  core.seekTo(seekTarget);
  dismissedSectionIds[sectionGroup.id] = true;
  if (
    !(options && options.keepOverlayVisible) &&
    currentOverlaySection &&
    currentOverlaySection.id === sectionGroup.id
  ) {
    setOverlayVisible(false, null);
  }
}

function handleSkipKeyDown(data) {
  if (!overlayVisible || overlayMode !== 'prompt' || !currentOverlaySection) {
    return false;
  }

  if (data && data.isRepeat) {
    return true;
  }

  skipSection(currentOverlaySection, 'Skip requested from key binding');
  return true;
}

function unregisterSkipKeyBinding() {
  if (!registeredSkipKeyBinding || !input || typeof input.onKeyDown !== 'function') return;

  try {
    input.onKeyDown(registeredSkipKeyBinding, null);
  } catch (error) {
    log('Skip key binding unregister failed: ' + error);
  }
  registeredSkipKeyBinding = null;
}

function syncSkipKeyBinding() {
  if (!input || typeof input.onKeyDown !== 'function') return;

  const keyBinding = getSkipKeyBinding();
  if (keyBinding === registeredSkipKeyBinding) return;

  unregisterSkipKeyBinding();
  if (!keyBinding) return;

  try {
    input.onKeyDown(keyBinding, handleSkipKeyDown);
    registeredSkipKeyBinding = keyBinding;
    log('Registered skip key binding: ' + keyBinding);
  } catch (error) {
    log('Skip key binding registration failed for "' + keyBinding + '": ' + error);
  }
}

function registerHandlers() {
  if (handlersRegistered) return;
  handlersRegistered = true;
  syncSkipKeyBinding();

  overlay.onMessage('skip', function () {
    skipSection(currentOverlaySection, 'Skip requested');
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

function sendState(visible, sectionGroup, options) {
  const resolvedOptions = options || {};
  const mode = resolvedOptions.mode === 'status' ? 'status' : 'prompt';
  const autoDismissSeconds = getPopupAutoDismissSeconds();
  overlayVisible = visible;
  overlayMode = visible ? mode : null;
  currentOverlaySection = visible && mode === 'prompt' ? sectionGroup : null;
  if (!visible || mode !== 'status') {
    autoSkipStatusSectionId = null;
    autoSkipStatusPhase = null;
  }
  overlay.postMessage('state', {
    visible: visible,
    sectionId: sectionGroup ? sectionGroup.id : null,
    mode: mode,
    autoDismissMs: autoDismissSeconds * 1000,
    playbackPaused: isPlaybackPaused(),
    label: resolvedOptions.label || null,
    skipLabel: getSkipLabel(sectionGroup),
    buttonStyle: getPopupButtonStyle(),
  });
}

function setOverlayVisible(visible, sectionGroup, options) {
  const mode = options && options.mode === 'status' ? 'status' : 'prompt';
  sendState(visible, sectionGroup, options);
  overlay.setClickable(visible && mode === 'prompt');
}

function hideAutoSkipStatus(sectionId) {
  if (sectionId && autoSkipStatusSectionId !== sectionId) return;
  if (overlayMode === 'status') {
    setOverlayVisible(false, null);
  }
}

function showAutoSkipStatus(sectionGroup, phase) {
  if (!sectionGroup) return;

  if (
    overlayVisible &&
    overlayMode === 'status' &&
    autoSkipStatusSectionId === sectionGroup.id &&
    autoSkipStatusPhase === phase
  ) {
    return;
  }

  clearAutoSkipStatusTimer();
  autoSkipStatusSectionId = sectionGroup.id;
  autoSkipStatusPhase = phase;
  setOverlayVisible(true, sectionGroup, {
    mode: 'status',
    label:
      phase === 'complete'
        ? getAutoSkipCompleteLabel(sectionGroup)
        : getAutoSkipPendingLabel(sectionGroup),
  });

  if (phase === 'complete') {
    autoSkipStatusHideTimer = setTimeout(function () {
      autoSkipStatusHideTimer = null;
      hideAutoSkipStatus(sectionGroup.id);
    }, AUTO_SKIP_STATUS_AFTER_SECONDS * 1000);
  }
}

function getActiveSection(position, leadInSeconds) {
  const resolvedLeadInSeconds =
    typeof leadInSeconds === 'number' && isFinite(leadInSeconds)
      ? leadInSeconds
      : INTRO_PROMPT_LEAD_IN;

  for (let i = 0; i < detectedSections.length; i++) {
    const sectionGroup = detectedSections[i];
    if (dismissedSectionIds[sectionGroup.id]) continue;

    if (
      position >= Math.max(0, sectionGroup.start - resolvedLeadInSeconds) &&
      position < sectionGroup.end
    ) {
      return sectionGroup;
    }
  }

  return null;
}

function updateOverlay(position) {
  if (!overlayReady) return;
  syncSkipKeyBinding();

  if (typeof position !== 'number') {
    position = getPosition();
  }
  if (typeof position !== 'number' || !isFinite(position)) {
    return;
  }

  const activeAutoSkipSection = getActiveSection(position, AUTO_SKIP_STATUS_LEAD_IN_SECONDS);
  if (activeAutoSkipSection && shouldAutoSkipSection(activeAutoSkipSection)) {
    if (overlayVisible && overlayMode === 'prompt') {
      setOverlayVisible(false, null);
    }
    if (
      position <
      activeAutoSkipSection.start + activeAutoSkipSection.autoSkipStartDelaySeconds
    ) {
      if (activeAutoSkipSection.showAutoSkipStatus) {
        showAutoSkipStatus(activeAutoSkipSection, 'pending');
      }
      return;
    }

    skipSection(
      activeAutoSkipSection,
      'Auto-skip triggered for ' + getSectionDescription(activeAutoSkipSection),
      {
        keepOverlayVisible: activeAutoSkipSection.showAutoSkipStatus,
      },
    );
    if (activeAutoSkipSection.showAutoSkipStatus) {
      showAutoSkipStatus(activeAutoSkipSection, 'complete');
    }
    return;
  }

  if (overlayMode === 'status') {
    if (autoSkipStatusPhase === 'pending') {
      setOverlayVisible(false, null);
    }
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
  clearAutoSkipStatusTimer();
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
