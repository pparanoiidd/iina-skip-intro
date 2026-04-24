const core = iina.core;
const event = iina.event;
const mpv = iina.mpv;
const overlay = iina.overlay;
const preferences = iina.preferences;
const console = iina.console;
const file = iina.file;
const iinaUtils = iina.utils;

const INTRO_PROMPT_LEAD_IN = 1;
const INTRO_PROMPT_AUTO_DISMISS_MS = 10000;
const AUDIO_MATCH_PLAYLIST_DELAY_MS = 2000; // Delay to allow playlist properties to update
const AUDIO_MATCH_MAX_REFERENCE_FILES = 4;
const AUDIO_MATCH_HELPER_PATH = './vendor/intro-match/tools/iina-helper.js';
const PLUGIN_PACKAGE_NAME = 'com.pparanoiidd.skipintro.iinaplugin';
const PLUGIN_DEV_PACKAGE_NAME = 'com.pparanoiidd.skipintro.iinaplugin-dev';
const PREF_DETECT_CHAPTER_TITLES = 'detect_chapter_titles';
const PREF_DETECT_AUDIO_MATCHING = 'detect_audio_matching';
const PREF_DETECT_CHAPTER_TIMING = 'detect_chapter_timing';
const PREF_PROGRESS_INDICATOR_STYLE = 'progress_indicator_style';
const PREF_DETECT_RECAPS = 'detect_recaps';
const PROGRESS_INDICATOR_FULL = 'full';
const PROGRESS_INDICATOR_BAR = 'bar';
const SECTION_KIND_INTRO = 'intro';
const SECTION_KIND_RECAP = 'recap';
const SECTION_KIND_SECTION = 'section';
const SECTION_SOURCE_TITLE = 'title';
const SECTION_SOURCE_TIMING = 'timing';
const SECTION_SOURCE_AUDIO_FINGERPRINT = 'audio-fingerprint';
const SECTION_GROUP_MAX_GAP = 1;
const MEDIA_FILE_EXTENSION_REGEX =
  /\.(?:3g2|3gp|avi|flv|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|ogm|ogv|rmvb|ts|webm|wmv)$/i;
const BAD_REFERENCE_FILENAME_REGEX =
  /(?:^|[\s._\-[\(])(?:sample|trailer|extras?|ncop|nced|oped|creditless|preview)(?:$|[\s._\-\]\)])/i;
const SEASON_EPISODE_REGEXES = [
  /(?:^|[\s._\-[\(])s(\d{1,2})[\s._\-\]\[]*(ep|sp|e|x)[\s._-]*(\d{1,4})(?:v\d+)?(?=$|[\s._\-\]\)])/i,
  /(?:^|[\s._\-[\(])(\d{1,2})x(\d{1,4})(?:v\d+)?(?=$|[\s._\-\]\)])/i,
];
const SEASON_WORD_REGEX = /\b(?:season|saison|temporada|stagione|staffel|serie)[. _-]?(\d{1,2})\b/i;
const SEASON_ONLY_REGEX = /(?:^|[\s._\-[\(])s(\d{1,2})(?!\d)(?=$|[\s._\-\]\)])/i;
const SEASON_ORDINAL_PREFIX_REGEX =
  /\b(\d{1,2})(?:st|nd|rd|th)[. _-]*(?:season|saison|temporada|stagione|staffel|serie)\b/i;
const EPISODE_WORD_REGEX = /\b(?:ep(?:isode)?|eps?|[ée]p(?:isode)?)[. _-]?(\d{1,4})(?:v\d+)?\b/i;
const SINGLE_E_EPISODE_REGEX = /(?:^|[\s._-])e[\s._-]*(\d{1,4})(?:v\d+)?(?=$|[\s._\-\]\)])/i;
const SEASON_DASH_EPISODE_REGEX = /^[\s._\-\]\)]*-[\s._-]*(\d{1,4})(?:v\d+)?(?=$|[\s._\-\]\)])/i;
const NUMBER_WORD_MAP = Object.freeze({
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
});
const NUMBER_WORD_PATTERN = Object.keys(NUMBER_WORD_MAP)
  .sort(function (a, b) {
    return b.length - a.length || a.localeCompare(b);
  })
  .join('|');
const SEASON_WORD_TEXT_BEFORE_REGEX = new RegExp(
  '\\b(' + NUMBER_WORD_PATTERN + ')[. _-]*(?:season|saison|temporada|stagione|staffel|serie)\\b',
  'i',
);
const SEASON_WORD_TEXT_AFTER_REGEX = new RegExp(
  '\\b(?:season|saison|temporada|stagione|staffel|serie)[. _-]*(' + NUMBER_WORD_PATTERN + ')\\b',
  'i',
);

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
const BINARY_CANDIDATES = Object.freeze({
  ffmpeg: ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'],
  node: ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'],
  bun: ['/opt/homebrew/bin/bun', '/usr/local/bin/bun', '~/.bun/bin/bun'],
});

let overlayReady = false;
let overlayVisible = false;
let overlayInitialized = false;
let handlersRegistered = false;
let detectedSections = [];
let currentOverlaySection = null;
let dismissedSectionIds = Object.create(null);
let detectionRunId = 0;
const binaryPathCache = Object.create(null);
let audioRuntimePath = undefined;
let homeDirectory = undefined;
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

function logAudio(message) {
  log('Audio intro detection: ' + message);
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
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
    detectTitleSections: !options || options.detectChapterTitles !== false,
    detectTimingSections: !!(options && options.detectChapterTiming),
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
    const end =
      endChapterIndex < chapters.length ? getChapterStart(chapters[endChapterIndex]) : null;
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
      typeof current.nextLengthRank === 'number' &&
      current.nextLengthRank <= INTRO_TIMING_TOP_LONGEST_COUNT;
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

function detectSectionsFromChapterTitles(chapters, duration, options) {
  const resolvedOptions = getDetectionOptions(options);
  const titleSections = resolvedOptions.detectTitleSections
    ? collectSectionsFromChapterTitles(chapters, duration, resolvedOptions) || []
    : [];

  return groupConnectedSections(titleSections);
}

function detectSectionsFromChapterTiming(chapters, duration, options) {
  const resolvedOptions = getDetectionOptions(options);
  const timingSection = resolvedOptions.detectTimingSections
    ? detectSectionFromChapterTiming(chapters, duration, resolvedOptions)
    : null;

  return timingSection ? groupConnectedSections([timingSection]) : [];
}

async function getHomeDirectory() {
  if (homeDirectory !== undefined) {
    return homeDirectory;
  }

  try {
    const result = await iinaUtils.exec('/usr/bin/printenv', ['HOME']);
    homeDirectory = result.status === 0 ? result.stdout.trim() || null : null;
  } catch (error) {
    homeDirectory = null;
  }

  return homeDirectory;
}

async function expandCandidatePath(path) {
  if (path.indexOf('~/') !== 0) return path;

  const home = await getHomeDirectory();
  return home ? home + path.slice(1) : null;
}

async function locateBinary(binary) {
  if (binaryPathCache[binary] !== undefined) {
    return binaryPathCache[binary];
  }

  const candidates = BINARY_CANDIDATES[binary] || [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = await expandCandidatePath(candidates[i]);
    if (!candidate) continue;

    try {
      if (file.exists(candidate)) {
        binaryPathCache[binary] = candidate;
        return candidate;
      }
    } catch (error) {
      // Keep trying other candidates.
    }
  }

  // IINA's fileInPath can miss GUI-unavailable shell paths; keep it as a backup only.
  try {
    const found = iinaUtils.fileInPath(binary);
    if (found) {
      binaryPathCache[binary] = found;
      return found;
    }
  } catch (error) {
    // Fall through to an execution probe.
  }

  try {
    const result = await iinaUtils.exec(binary, ['-version']);
    binaryPathCache[binary] = result.status === 0 ? binary : null;
    return binaryPathCache[binary];
  } catch (error) {
    binaryPathCache[binary] = null;
    return null;
  }
}

async function locateAudioRuntime() {
  if (audioRuntimePath !== undefined) {
    return audioRuntimePath;
  }

  audioRuntimePath = (await locateBinary('bun')) || (await locateBinary('node')) || null;
  return audioRuntimePath;
}

function resolvePluginPath(path) {
  try {
    return iinaUtils.resolvePath(path);
  } catch (error) {
    return path;
  }
}

function joinPath(base, path) {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\.?\//, '');
}

function fileExists(path) {
  try {
    if (file.exists(path)) return true;
  } catch (error) {}

  try {
    if (iinaUtils.fileInPath(path)) return true;
  } catch (error) {}

  const resolvedPath = resolvePluginPath(path);
  if (resolvedPath === path) return false;

  try {
    return file.exists(resolvedPath);
  } catch (error) {}

  try {
    return !!iinaUtils.fileInPath(resolvedPath);
  } catch (error) {
    return false;
  }
}

function getAudioMatchHelperPath() {
  const triedPaths = [];

  const tildeInstalledPath = joinPath(
    '~/Library/Application Support/com.colliderli.iina/plugins/' + PLUGIN_PACKAGE_NAME,
    AUDIO_MATCH_HELPER_PATH,
  );
  if (triedPaths.indexOf(tildeInstalledPath) === -1) triedPaths.push(tildeInstalledPath);
  if (fileExists(tildeInstalledPath)) return resolvePluginPath(tildeInstalledPath);

  const tildeDevPath = joinPath(
    '~/Library/Application Support/com.colliderli.iina/plugins/' + PLUGIN_DEV_PACKAGE_NAME,
    AUDIO_MATCH_HELPER_PATH,
  );
  if (triedPaths.indexOf(tildeDevPath) === -1) triedPaths.push(tildeDevPath);
  if (fileExists(tildeDevPath)) return resolvePluginPath(tildeDevPath);

  logAudio('helper lookup tried: ' + triedPaths.join(' | '));
  return null;
}

function getCurrentMediaFile() {
  try {
    const items = getPlaylistItems();
    for (let i = 0; i < items.length; i++) {
      if (items[i].isPlaying || items[i].isCurrent) {
        const playlistPath = getPlaylistItemPath(items[i]);
        if (isPlayableLocalMedia(playlistPath)) {
          return getLocalFilePath(playlistPath);
        }
        logAudio('playlist current item is not a playable local media file');
      }
    }
  } catch (error) {
    logAudio('playlist lookup failed, falling back to mpv path: ' + error);
  }

  if (!mpv || typeof mpv.getString !== 'function') return null;

  const path = mpv.getString('path');
  const localPath = typeof path === 'string' && path ? getLocalFilePath(path) || path : null;
  logAudio('mpv current path: ' + (localPath || '(none)'));
  return localPath;
}

function getLocalFilePath(value) {
  if (!value) return null;

  if (/^file:\/\//i.test(value)) {
    const withoutScheme = value.replace(/^file:\/\/(?:localhost)?/i, '');
    try {
      return decodeURI(withoutScheme);
    } catch (error) {
      return withoutScheme;
    }
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return null;
  }

  return value;
}

function normalizeComparablePath(value) {
  const localPath = getLocalFilePath(value);
  if (!localPath) return null;
  return localPath.replace(/\/+$/, '').toLowerCase();
}

function getFilename(path) {
  const localPath = getLocalFilePath(path);
  if (!localPath) return '';

  const parts = localPath.split(/[\\/]/);
  return parts.length ? parts[parts.length - 1] : localPath;
}

function getFilenameStem(path) {
  return getFilename(path).replace(/\.[^.]+$/, '');
}

function isPlayableLocalMedia(path) {
  const localPath = getLocalFilePath(path);
  return !!(localPath && MEDIA_FILE_EXTENSION_REGEX.test(localPath));
}

function isBadReferenceFilename(path) {
  return BAD_REFERENCE_FILENAME_REGEX.test(getFilenameStem(path));
}

function numberWordToInt(word) {
  return word ? NUMBER_WORD_MAP[word.toLowerCase()] || NaN : NaN;
}

function parseIntOrNull(value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function findSeasonToken(text) {
  const matchers = [
    {
      regex: SEASON_WORD_REGEX,
      value: function (match) {
        return parseIntOrNull(match[1]);
      },
    },
    {
      regex: SEASON_ONLY_REGEX,
      value: function (match) {
        return parseIntOrNull(match[1]);
      },
    },
    {
      regex: SEASON_ORDINAL_PREFIX_REGEX,
      value: function (match) {
        return parseIntOrNull(match[1]);
      },
    },
    {
      regex: SEASON_WORD_TEXT_BEFORE_REGEX,
      value: function (match) {
        return numberWordToInt(match[1]);
      },
    },
    {
      regex: SEASON_WORD_TEXT_AFTER_REGEX,
      value: function (match) {
        return numberWordToInt(match[1]);
      },
    },
  ];

  for (let i = 0; i < matchers.length; i++) {
    const matcher = matchers[i];
    const match = text.match(matcher.regex);
    if (!match) continue;

    const season = matcher.value(match);
    if (Number.isFinite(season)) {
      return {
        season: season,
        index: match.index,
        endIndex: match.index + match[0].length,
      };
    }
  }

  return null;
}

function parseSeasonEpisode(path) {
  const text = getFilenameStem(path);
  if (!text) return null;

  for (let i = 0; i < SEASON_EPISODE_REGEXES.length; i++) {
    const match = text.match(SEASON_EPISODE_REGEXES[i]);
    if (!match) continue;

    const season = parseIntOrNull(match[1]);
    const kind = i === 0 ? (match[2] || '').toLowerCase() : '';
    const episode = parseIntOrNull(i === 0 ? match[3] : match[2]);
    if (Number.isFinite(season) && Number.isFinite(episode)) {
      return {
        season: season,
        episode: episode,
        index: match.index,
        isSpecial: kind === 'sp',
      };
    }
  }

  const seasonToken = findSeasonToken(text);
  if (!seasonToken) return null;

  let episode = null;
  let episodeIndex = Infinity;
  const episodeWord = text.match(EPISODE_WORD_REGEX);
  if (episodeWord) {
    episode = parseIntOrNull(episodeWord[1]);
    episodeIndex = episodeWord.index;
  }

  if (!Number.isFinite(episode)) {
    const singleE = text.match(SINGLE_E_EPISODE_REGEX);
    if (singleE) {
      episode = parseIntOrNull(singleE[1]);
      episodeIndex = singleE.index;
    }
  }

  if (!Number.isFinite(episode)) {
    const afterSeason = text.slice(seasonToken.endIndex);
    const dashEpisode = afterSeason.match(SEASON_DASH_EPISODE_REGEX);
    if (dashEpisode) {
      episode = parseIntOrNull(dashEpisode[1]);
      episodeIndex = seasonToken.endIndex + dashEpisode.index;
    }
  }

  if (!Number.isFinite(episode)) return null;

  return {
    season: seasonToken.season,
    episode: episode,
    index: Math.min(seasonToken.index, episodeIndex),
    isSpecial: false,
  };
}

function getPlaylistItemPath(item) {
  return item && item.filename ? item.filename : null;
}

function getMpvPlaylistIndex(property) {
  try {
    const index = mpv.getNumber(property);
    return Number.isFinite(index) ? index : -1;
  } catch (error) {
    return -1;
  }
}

function getMpvPlaylistString(property) {
  try {
    return mpv.getString(property);
  } catch (error) {
    return null;
  }
}

function getPlaylistItems() {
  const count = getMpvPlaylistIndex('playlist-count');
  if (count <= 0) {
    return [];
  }

  const playingIndex = getMpvPlaylistIndex('playlist-playing-pos');
  const currentIndex = getMpvPlaylistIndex('playlist-pos');
  const items = [];

  for (let i = 0; i < count; i++) {
    const filename = getMpvPlaylistString('playlist/' + i + '/filename');
    if (!filename) continue;

    items.push({
      filename: filename,
      isPlaying: i === playingIndex,
      isCurrent: i === currentIndex,
      playlistIndex: i,
    });
  }

  return items;
}

function buildPlaylistReferenceCandidates(items, currentIndex) {
  const candidates = [];
  for (let i = 0; i < items.length; i++) {
    const path = getPlaylistItemPath(items[i]);
    if (i === currentIndex || !isPlayableLocalMedia(path) || isBadReferenceFilename(path)) {
      continue;
    }

    const parsed = parseSeasonEpisode(path);
    candidates.push({
      index: i,
      path: getLocalFilePath(path),
      parsed: parsed,
    });
  }

  return candidates;
}

function getCurrentPlaylistIndex(items, mainFile) {
  for (let i = 0; i < items.length; i++) {
    if (items[i].isPlaying || items[i].isCurrent) {
      return i;
    }
  }

  const currentPath = normalizeComparablePath(mainFile);
  if (!currentPath) return -1;

  for (let j = 0; j < items.length; j++) {
    if (normalizeComparablePath(getPlaylistItemPath(items[j])) === currentPath) {
      return j;
    }
  }

  return -1;
}

function sortByPlaylistOrder(a, b) {
  return a.index - b.index;
}

function sortByPlaylistDistance(currentIndex) {
  return function (a, b) {
    const aDistance = Math.abs(a.index - currentIndex);
    const bDistance = Math.abs(b.index - currentIndex);
    const aPrevious = a.index < currentIndex ? 0 : 1;
    const bPrevious = b.index < currentIndex ? 0 : 1;

    return aDistance - bDistance || aPrevious - bPrevious || a.index - b.index;
  };
}

function getAudioReferenceFiles(mainFile) {
  const items = getPlaylistItems();
  const currentIndex = getCurrentPlaylistIndex(items, mainFile);
  if (currentIndex < 0) {
    logAudio('playlist scan: ' + items.length + ' item(s), no current item found');
    return [];
  }

  const currentPath = getPlaylistItemPath(items[currentIndex]) || mainFile;
  const currentParsed = parseSeasonEpisode(currentPath);
  const candidates = buildPlaylistReferenceCandidates(items, currentIndex);
  logAudio(
    'playlist scan: ' +
      items.length +
      ' item(s), current index ' +
      currentIndex +
      ', current ' +
      (currentParsed
        ? 'S' +
          currentParsed.season +
          'E' +
          currentParsed.episode +
          (currentParsed.isSpecial ? ' special' : '')
        : '(unparsed)'),
  );
  let selected = [];

  if (currentParsed && !currentParsed.isSpecial) {
    selected = candidates
      .filter(function (candidate) {
        return (
          candidate.parsed &&
          !candidate.parsed.isSpecial &&
          candidate.parsed.season === currentParsed.season &&
          candidate.parsed.episode !== currentParsed.episode
        );
      })
      .sort(sortByPlaylistOrder);
    logAudio(
      'reference candidates: ' + candidates.length + ' usable, ' + selected.length + ' same-season',
    );
  } else {
    selected = candidates.sort(sortByPlaylistDistance(currentIndex));
    logAudio(
      'reference candidates: ' + candidates.length + ' usable, using playlist-neighbor fallback',
    );
  }

  const referenceFiles = selected
    .slice(0, AUDIO_MATCH_MAX_REFERENCE_FILES)
    .map(function (candidate) {
      return candidate.path;
    });
  logAudio(
    'selected reference file(s): ' +
      (referenceFiles.length ? referenceFiles.join(' | ') : '(none)'),
  );
  return referenceFiles;
}

function isValidAudioMatchOutput(output) {
  if (!output || !output.intro) return false;

  const start = output.intro.start_seconds;
  const end = output.intro.end_seconds;
  return (
    typeof start === 'number' &&
    isFinite(start) &&
    typeof end === 'number' &&
    isFinite(end) &&
    start >= 0 &&
    end > start
  );
}

function buildAudioMatchSectionGroup(output) {
  const start = output.intro.start_seconds;
  const end = output.intro.end_seconds;
  const id = 'audio-intro-' + Math.round(start * 1000) + '-' + Math.round(end * 1000);

  return {
    id: id,
    start: start,
    end: end,
    sections: [
      {
        start: start,
        end: end,
        titles: ['Audio fingerprint intro'],
        source: SECTION_SOURCE_AUDIO_FINGERPRINT,
        kind: SECTION_KIND_INTRO,
        confidence: output.confidence || null,
        sharedAudio: output.shared_audio || null,
      },
    ],
  };
}

async function detectSectionFromAudioMatch() {
  logAudio('waiting ' + AUDIO_MATCH_PLAYLIST_DELAY_MS + 'ms before reading playlist');
  await delay(AUDIO_MATCH_PLAYLIST_DELAY_MS);

  const mainFile = getCurrentMediaFile();
  const referenceFiles = getAudioReferenceFiles(mainFile);

  if (!mainFile || !Array.isArray(referenceFiles) || !referenceFiles.length) {
    logAudio('skipped: missing current file or reference files');
    return null;
  }

  const runtime = await locateAudioRuntime();
  if (!runtime) {
    logAudio('skipped: neither bun nor node was found');
    return null;
  }
  logAudio('using runtime: ' + runtime);

  const helperPath = getAudioMatchHelperPath();
  if (!helperPath) {
    logAudio('skipped: audio matcher helper was not found');
    return null;
  }
  logAudio('using helper: ' + helperPath);

  const ffmpegPath = await locateBinary('ffmpeg');
  if (!ffmpegPath) {
    logAudio('skipped: ffmpeg was not found');
    return null;
  }
  logAudio('using ffmpeg: ' + ffmpegPath);

  const refs = referenceFiles.slice(0, AUDIO_MATCH_MAX_REFERENCE_FILES);
  const args = [helperPath, '--main', mainFile, '--refs-json', JSON.stringify(refs)];
  if (ffmpegPath) {
    args.push('--ffmpeg', ffmpegPath);
  }

  logAudio('running helper with ' + refs.length + ' reference file(s)');
  const result = await iinaUtils.exec(runtime, args);
  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch (error) {
    logAudio('helper returned invalid JSON stdout: ' + (result.stdout || '(empty)'));
    if (result.stderr) logAudio('helper stderr: ' + result.stderr);
    return null;
  }

  if (!payload.ok) {
    logAudio(
      'helper reported no match' +
        (payload.code ? ' [' + payload.code + ']' : '') +
        ': ' +
        (payload.message || '(no message)'),
    );
    return null;
  }

  const output = payload.output;
  if (isValidAudioMatchOutput(output)) {
    logAudio(
      'matcher returned intro ' +
        output.intro.start_seconds.toFixed(2) +
        's-' +
        output.intro.end_seconds.toFixed(2) +
        's, confidence ' +
        (output.confidence
          ? output.confidence.score + ' (' + output.confidence.label + ')'
          : '(unknown)'),
    );
  } else {
    logAudio('matcher returned an invalid intro result');
  }

  return isValidAudioMatchOutput(output) ? buildAudioMatchSectionGroup(output) : null;
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
