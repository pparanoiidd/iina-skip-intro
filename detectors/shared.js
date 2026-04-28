const SECTION_KIND_INTRO = 'intro';
const SECTION_KIND_RECAP = 'recap';
const SECTION_KIND_CREDITS = 'credits';
const SECTION_KIND_SECTION = 'section';
const SECTION_SOURCE_TITLE = 'title';
const SECTION_SOURCE_TIMING = 'timing';
const SECTION_SOURCE_AUDIO_FINGERPRINT = 'audio-fingerprint';
const SECTION_GROUP_MAX_GAP = 1;
const INTRO_MAX_START_RATIO = 0.25;
const VIDEO_FILE_EXTENSIONS = Object.freeze([
  'mkv',
  'mp4',
  'avi',
  'm4v',
  'mov',
  '3gp',
  'ts',
  'mts',
  'm2ts',
  'wmv',
  'flv',
  'f4v',
  'asf',
  'webm',
  'rm',
  'rmvb',
  'qt',
  'dv',
  'mpg',
  'mpeg',
  'mxf',
  'vob',
  'ogv',
  'ogm',
]);
const VIDEO_FILE_EXTENSION_MAP = VIDEO_FILE_EXTENSIONS.reduce(function (map, extension) {
  map[extension] = true;
  return map;
}, Object.create(null));

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

function getFilename(path) {
  const localPath = getLocalFilePath(path);
  if (!localPath) return '';

  const parts = localPath.split(/[\\/]/);
  return parts.length ? parts[parts.length - 1] : localPath;
}

function isVideoFilePath(path) {
  const filename = getFilename(path);
  if (!filename) return false;

  const extensionMatch = filename.match(/\.([^.]+)$/);
  return !!(extensionMatch && VIDEO_FILE_EXTENSION_MAP[extensionMatch[1].toLowerCase()]);
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

  if (
    normalized === 'credits' ||
    normalized === 'credit' ||
    normalized === 'end credits' ||
    normalized === 'ending credits' ||
    normalized === 'closing credits' ||
    normalized === 'final credits' ||
    normalized === 'staff credits' ||
    normalized === 'credit roll' ||
    normalized === 'credits roll' ||
    normalized === 'credits start' ||
    /^credits?\s+\d+$/.test(normalized) ||
    /^ed\s*\d*$/.test(normalized) ||
    /^ending(?:\s+\d+|\s+(?:theme|song|credits))$/.test(normalized) ||
    normalized === 'clean ending' ||
    normalized === 'textless ending' ||
    /^nced\s*\d*$/.test(normalized) ||
    /^nc\s+ed\s*\d*$/.test(normalized) ||
    /^non credit ending(?:\s+\d+)?$/.test(normalized)
  ) {
    return SECTION_KIND_CREDITS;
  }

  return null;
}

function isPlainIntroChapterTitle(title) {
  return normalizeChapterTitle(title) === 'intro';
}

function isSpecificIntroChapterTitle(title) {
  return classifyChapterTitle(title) === SECTION_KIND_INTRO && !isPlainIntroChapterTitle(title);
}

function getDetectionOptions(options) {
  return {
    detectIntros: !options || options.detectIntros !== false,
    detectRecaps: !!(options && options.detectRecaps),
    detectCredits: !options || options.detectCredits !== false,
    detectTitleSections: !options || options.detectChapterTitles !== false,
    detectTimingSections: !!(options && options.detectChapterTiming),
  };
}

function isAllowedTitleKind(kind, options) {
  return (
    (kind === SECTION_KIND_INTRO && !!options.detectIntros) ||
    (kind === SECTION_KIND_CREDITS && !!options.detectCredits) ||
    (kind === SECTION_KIND_RECAP && !!options.detectRecaps)
  );
}

function isSectionStartInRange(start, duration, maxStart) {
  return start >= 0 && start <= maxStart && start <= duration * INTRO_MAX_START_RATIO;
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

module.exports = {
  SECTION_KIND_INTRO: SECTION_KIND_INTRO,
  SECTION_KIND_RECAP: SECTION_KIND_RECAP,
  SECTION_KIND_CREDITS: SECTION_KIND_CREDITS,
  SECTION_KIND_SECTION: SECTION_KIND_SECTION,
  SECTION_SOURCE_TITLE: SECTION_SOURCE_TITLE,
  SECTION_SOURCE_TIMING: SECTION_SOURCE_TIMING,
  SECTION_SOURCE_AUDIO_FINGERPRINT: SECTION_SOURCE_AUDIO_FINGERPRINT,
  classifyChapterTitle: classifyChapterTitle,
  getFilename: getFilename,
  getChapterStart: getChapterStart,
  getChapterEnd: getChapterEnd,
  getDetectionOptions: getDetectionOptions,
  getLocalFilePath: getLocalFilePath,
  groupConnectedSections: groupConnectedSections,
  isPlainIntroChapterTitle: isPlainIntroChapterTitle,
  isAllowedTitleKind: isAllowedTitleKind,
  isSectionStartInRange: isSectionStartInRange,
  isSpecificIntroChapterTitle: isSpecificIntroChapterTitle,
  isVideoFilePath: isVideoFilePath,
  normalizeChapterTitle: normalizeChapterTitle,
};
