const core = iina.core;
const event = iina.event;
const mpv = iina.mpv;
const overlay = iina.overlay;
const preferences = iina.preferences;
const console = iina.console;

const INTRO_PROMPT_LEAD_IN = 1;
const INTRO_PROMPT_AUTO_DISMISS_MS = 10000;
const PREF_PROGRESS_INDICATOR_STYLE = 'progress_indicator_style';
const PREF_DETECT_RECAPS = 'detect_recaps';
const PROGRESS_INDICATOR_FULL = 'full';
const PROGRESS_INDICATOR_BAR = 'bar';
const SECTION_KIND_INTRO = 'intro';
const SECTION_KIND_RECAP = 'recap';
const SECTION_KIND_SECTION = 'section';
const SECTION_SOURCE_TITLE = 'title';
const SECTION_SOURCE_TIMING = 'timing';
const SECTION_GROUP_MAX_GAP = 1;

const INTRO_MAX_START = 300;
const INTRO_MIN_DURATION = 15;
const INTRO_SINGLE_MAX_DURATION = 140;
const INTRO_COMBINED_MAX_DURATION = 240;
const INTRO_MAX_START_RATIO = 0.25;

const INTRO_TIMING_MAX_START = 360;
const INTRO_TIMING_MAX_CHAPTER_INDEX = 4;
const INTRO_TIMING_MIN_DURATION = 20;
const INTRO_TIMING_MAX_DURATION = 140;
const INTRO_TIMING_MIN_NEXT_DURATION = 180;
const INTRO_TIMING_MIN_NEXT_RATIO = 2.5;
const INTRO_TIMING_MIN_NEXT_RUNTIME_RATIO = 0.2;
const INTRO_TIMING_TOP_LONGEST_COUNT = 3;
const INTRO_TIMING_MIN_SCORE = 60;
const INTRO_TIMING_MIN_MARGIN = 12;
const INTRO_TIMING_INTRO_TITLE_BONUS = 8;
const INTRO_TIMING_RECAP_TITLE_BONUS = 20;

let overlayReady = false;
let overlayVisible = false;
let overlayInitialized = false;
let handlersRegistered = false;
let detectedSections = [];
let currentOverlaySection = null;
let dismissedSectionIds = Object.create(null);
const RECAP_TITLES = {
  recap: true,
  'previously on': true,
  'last time on': true,
  'previous episode': true,
  'story so far': true,
  'episode recap': true,
  'series recap': true,
  digest: true,
  summary: true,
};

function log(message) {
  console.log(message);
}

function getPosition() {
  const position = mpv.getNumber('time-pos');
  return typeof position === 'number' && isFinite(position) ? position : null;
}

function getDuration() {
  const duration = mpv.getNumber('duration');
  return typeof duration === 'number' && isFinite(duration) && duration > 0 ? duration : null;
}

function getChapterStart(chapter) {
  if (!chapter) return null;
  return typeof chapter.start === 'number' && isFinite(chapter.start) ? chapter.start : null;
}

function getChapterEnd(chapters, index, duration) {
  if (!Array.isArray(chapters) || index < 0 || index >= chapters.length) return null;

  const nextStart = index + 1 < chapters.length ? getChapterStart(chapters[index + 1]) : duration;
  return typeof nextStart === 'number' && isFinite(nextStart) ? nextStart : null;
}

function normalizeChapterTitle(title) {
  if (typeof title !== 'string') return '';
  return title
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;,.!?-]+|[\s:;,.!?-]+$/g, '');
}

function classifyChapterTitle(title) {
  const normalized = normalizeChapterTitle(title);
  if (!normalized) return null;

  if (
    /^studio logo(?:\s+\d+)?$/.test(normalized) ||
    /^op\s*\d*$/.test(normalized) ||
    /^opening(?:\s+\d+|\s+(?:theme|song|credits))?$/.test(normalized) ||
    normalized === 'intro' ||
    normalized === 'title card' ||
    normalized === 'title sequence' ||
    normalized === 'main title' ||
    /^ncop\s*\d*$/.test(normalized) ||
    /^non credit opening(?:\s+\d+)?$/.test(normalized)
  ) {
    return SECTION_KIND_INTRO;
  }

  if (RECAP_TITLES[normalized]) {
    return SECTION_KIND_RECAP;
  }

  return null;
}

function getDetectionOptions(options) {
  return {
    detectRecaps: !!(options && options.detectRecaps),
  };
}

function isAllowedTitleKind(kind, options) {
  return kind === SECTION_KIND_INTRO || (kind === SECTION_KIND_RECAP && !!options.detectRecaps);
}

function isSectionStartInRange(start, duration, maxStart) {
  return start >= 0 && start <= maxStart && start <= duration * INTRO_MAX_START_RATIO;
}

function isValidTitleSection(start, end, duration, titleCount) {
  if (start === null || !isSectionStartInRange(start, duration, INTRO_MAX_START)) return false;
  if (end === null || end <= start) return false;

  const sectionDuration = end - start;
  const maxDuration = titleCount > 1 ? INTRO_COMBINED_MAX_DURATION : INTRO_SINGLE_MAX_DURATION;
  return sectionDuration >= INTRO_MIN_DURATION && sectionDuration <= maxDuration;
}

function collectSectionsFromChapterTitles(chapters, duration, options) {
  if (!Array.isArray(chapters) || chapters.length < 2) return [];
  if (typeof duration !== 'number' || !isFinite(duration) || duration <= 0) return [];

  const sections = [];
  for (let i = 0; i < chapters.length - 1; ) {
    const kind = classifyChapterTitle(chapters[i].title);
    if (!isAllowedTitleKind(kind, options)) {
      i++;
      continue;
    }

    let endChapterIndex = i + 1;
    const titles = [chapters[i].title || ''];
    while (
      endChapterIndex < chapters.length &&
      classifyChapterTitle(chapters[endChapterIndex].title) === kind
    ) {
      titles.push(chapters[endChapterIndex].title || '');
      endChapterIndex++;
    }

    const start = getChapterStart(chapters[i]);
    const end = endChapterIndex < chapters.length ? getChapterStart(chapters[endChapterIndex]) : null;
    if (isValidTitleSection(start, end, duration, titles.length)) {
      sections.push({
        start: start,
        end: end,
        titles: titles,
        source: SECTION_SOURCE_TITLE,
        kind: kind,
      });
    }

    i = endChapterIndex;
  }

  return sections;
}

function buildTimingCandidates(chapters, duration) {
  if (!Array.isArray(chapters) || chapters.length < 2) return [];
  if (typeof duration !== 'number' || !isFinite(duration) || duration <= 0) return [];

  const derived = [];
  for (let i = 0; i < chapters.length; i++) {
    const start = getChapterStart(chapters[i]);
    const end = getChapterEnd(chapters, i, duration);
    if (start === null || end === null || end <= start) continue;

    derived.push({
      chapter: chapters[i],
      chapterNumber: i + 1,
      start: start,
      end: end,
      length: end - start,
      titleKind: classifyChapterTitle(chapters[i].title),
    });
  }

  if (derived.length < 2) return [];

  const lengths = derived
    .map(function (chapter) {
      return chapter.length;
    })
    .sort(function (a, b) {
      return b - a;
    });

  for (let j = 0; j < derived.length; j++) {
    const current = derived[j];
    const prev = j > 0 ? derived[j - 1] : null;
    const next = j + 1 < derived.length ? derived[j + 1] : null;
    current.prevLength = prev ? prev.length : null;
    current.nextLength = next ? next.length : null;
    current.nextLengthRank = next ? lengths.indexOf(next.length) + 1 : null;
    current.nextIsTopLongest =
      typeof current.nextLengthRank === 'number' && current.nextLengthRank <= INTRO_TIMING_TOP_LONGEST_COUNT;
  }

  return derived;
}

function getTimingRejectionReason(candidate, duration) {
  if (!candidate) return 'invalid-candidate';
  if (candidate.chapterNumber > INTRO_TIMING_MAX_CHAPTER_INDEX) return 'chapter-position';
  if (!isSectionStartInRange(candidate.start, duration, INTRO_TIMING_MAX_START)) {
    return 'late-start';
  }
  if (
    candidate.length < INTRO_TIMING_MIN_DURATION ||
    candidate.length > INTRO_TIMING_MAX_DURATION
  ) {
    return 'chapter-length';
  }
  if (
    typeof candidate.nextLength !== 'number' ||
    candidate.nextLength < INTRO_TIMING_MIN_NEXT_DURATION
  ) {
    return 'short-next-chapter';
  }
  if (candidate.nextLength / candidate.length < INTRO_TIMING_MIN_NEXT_RATIO) {
    return 'weak-next-ratio';
  }
  if (
    !candidate.nextIsTopLongest &&
    candidate.nextLength < duration * INTRO_TIMING_MIN_NEXT_RUNTIME_RATIO
  ) {
    return 'next-not-dominant';
  }

  return null;
}

function scoreTimingCandidate(candidate, options) {
  let score = 0;
  const reasons = [];

  if (candidate.chapterNumber === 1) {
    score += 20;
    reasons.push('chapter-1');
  } else if (candidate.chapterNumber === 2) {
    score += 15;
    reasons.push('chapter-2');
  } else if (candidate.chapterNumber === 3) {
    score += 8;
    reasons.push('chapter-3');
  } else if (candidate.chapterNumber === 4) {
    score += 3;
    reasons.push('chapter-4');
  }

  if (candidate.length >= 45 && candidate.length <= 110) {
    score += 20;
    reasons.push('ideal-duration');
  } else {
    score += 10;
    reasons.push('acceptable-duration');
  }

  if (candidate.nextLengthRank === 1) {
    score += 25;
    reasons.push('next-longest');
  } else if (candidate.nextLengthRank === 2) {
    score += 18;
    reasons.push('next-second-longest');
  } else if (candidate.nextLengthRank === 3) {
    score += 10;
    reasons.push('next-third-longest');
  }

  const nextRatio = candidate.nextLength / candidate.length;
  if (nextRatio >= 5) {
    score += 20;
    reasons.push('next-ratio-5x');
  } else if (nextRatio >= 3) {
    score += 12;
    reasons.push('next-ratio-3x');
  } else {
    score += 6;
    reasons.push('next-ratio-2.5x');
  }

  if (candidate.prevLength === null || candidate.prevLength <= 240) {
    score += 10;
    reasons.push('short-or-no-lead-in');
  } else if (candidate.prevLength <= 360) {
    score += 5;
    reasons.push('moderate-lead-in');
  }

  if (candidate.start <= 120) {
    score += 10;
    reasons.push('very-early-start');
  } else if (candidate.start <= 240) {
    score += 5;
    reasons.push('early-start');
  }

  if (candidate.titleKind === SECTION_KIND_INTRO) {
    score += INTRO_TIMING_INTRO_TITLE_BONUS;
    reasons.push('intro-title');
  } else if (options.detectRecaps && candidate.titleKind === SECTION_KIND_RECAP) {
    score += INTRO_TIMING_RECAP_TITLE_BONUS;
    reasons.push('recap-title');
  }

  return {
    score: score,
    reasons: reasons,
  };
}

function detectSectionFromChapterTiming(chapters, duration, options) {
  const candidates = buildTimingCandidates(chapters, duration);
  if (!candidates.length) return null;

  const scoredCandidates = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const rejectionReason = getTimingRejectionReason(candidate, duration);

    if (rejectionReason) {
      continue;
    }

    if (candidate.titleKind === SECTION_KIND_RECAP && !options.detectRecaps) {
      continue;
    }

    const scoreResult = scoreTimingCandidate(candidate, options);
    scoredCandidates.push({
      candidate: candidate,
      score: scoreResult.score,
      reasons: scoreResult.reasons,
    });
  }

  if (!scoredCandidates.length) return null;

  scoredCandidates.sort(function (a, b) {
    return b.score - a.score || a.candidate.chapterNumber - b.candidate.chapterNumber;
  });

  const winner = scoredCandidates[0];
  const runnerUp = scoredCandidates.length > 1 ? scoredCandidates[1] : null;
  const margin = runnerUp ? winner.score - runnerUp.score : winner.score;
  if (winner.score < INTRO_TIMING_MIN_SCORE || margin < INTRO_TIMING_MIN_MARGIN) {
    return null;
  }

  return {
    start: winner.candidate.start,
    end: winner.candidate.end,
    titles: [winner.candidate.chapter.title || ''],
    source: SECTION_SOURCE_TIMING,
    kind: winner.candidate.titleKind || SECTION_KIND_SECTION,
    chapterNumber: winner.candidate.chapterNumber,
    score: winner.score,
    reasons: winner.reasons,
  };
}

function sectionsOverlap(first, second) {
  if (!first || !second) return false;
  return first.start < second.end && second.start < first.end;
}

function groupConnectedSections(sections) {
  if (!Array.isArray(sections) || !sections.length) return [];

  const sortedSections = sections.slice().sort(function (a, b) {
    return a.start - b.start || a.end - b.end;
  });

  const groups = [];
  for (let i = 0; i < sortedSections.length; i++) {
    const section = sortedSections[i];
    const currentGroup = groups.length ? groups[groups.length - 1] : null;

    if (!currentGroup || section.start > currentGroup.end + SECTION_GROUP_MAX_GAP) {
      groups.push({
        id: 'section-' + (groups.length + 1),
        start: section.start,
        end: section.end,
        sections: [section],
      });
      continue;
    }

    currentGroup.end = Math.max(currentGroup.end, section.end);
    currentGroup.sections.push(section);
  }

  return groups;
}

function detectSectionsFromChapters(chapters, duration, options) {
  const resolvedOptions = getDetectionOptions(options);
  const titleSections = collectSectionsFromChapterTitles(chapters, duration, resolvedOptions) || [];
  const timingSection = detectSectionFromChapterTiming(chapters, duration, resolvedOptions);

  if (timingSection) {
    let overlapsExistingSection = false;
    for (let i = 0; i < titleSections.length; i++) {
      if (sectionsOverlap(timingSection, titleSections[i])) {
        overlapsExistingSection = true;
        break;
      }
    }

    if (!overlapsExistingSection) {
      titleSections.push(timingSection);
    }
  }

  return groupConnectedSections(titleSections);
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

function detectCurrentSections() {
  try {
    const duration = getDuration();
    const chapters = core.getChapters();
    detectedSections = detectSectionsFromChapters(chapters, duration, {
      detectRecaps: isRecapDetectionEnabled(),
    });
  } catch (error) {
    detectedSections = [];
    log('Chapter intro detection failed: ' + error);
  }

  if (!detectedSections.length) {
    log('No skip sections detected');
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
