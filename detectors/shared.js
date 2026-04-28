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
const SEASON_EPISODE_REGEXES = [
  /(?:^|[\s._\-[\(])s(\d{1,2})[\s._\-\]\[]*(ep|sp|e|x)[\s._-]*(\d{1,4})(?:v\d+)?(?=$|[\s._\-\]\)])/i,
  /(?:^|[\s._\-[\(])(\d{1,2})x(\d{1,4})(?:v\d+)?(?=$|[\s._\-\]\)])/i,
];
const STANDALONE_SPECIAL_EP_REGEX =
  /(?:^|[\s._\-[\(])(?:sp|special|ova|oav|oad)[\s._-]*(\d{1,4})(?:v\d+)?(?=$|[\s._\-\]\)])/i;
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

function getFilenameStem(path) {
  return getFilename(path).replace(/\.[^.]+$/, '');
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
  const standaloneSpecialEpisode = text.match(STANDALONE_SPECIAL_EP_REGEX);

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
        isSpecial: season === 0 || kind === 'sp' || !!standaloneSpecialEpisode,
      };
    }
  }

  const seasonToken = findSeasonToken(text);
  if (!seasonToken) {
    const specialEpisode = standaloneSpecialEpisode
      ? parseIntOrNull(standaloneSpecialEpisode[1])
      : null;
    return Number.isFinite(specialEpisode)
      ? {
          season: null,
          episode: specialEpisode,
          index: standaloneSpecialEpisode.index,
          isSpecial: true,
        }
      : null;
  }

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
    isSpecial: seasonToken.season === 0,
  };
}

function formatParsedSeasonEpisode(parsed) {
  if (!parsed) return '(unparsed)';

  const label = Number.isFinite(parsed.season)
    ? 'S' + parsed.season + 'E' + parsed.episode
    : 'SP' + parsed.episode;
  return label + (parsed.isSpecial ? ' special' : '');
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
  getFilenameStem: getFilenameStem,
  getChapterStart: getChapterStart,
  getChapterEnd: getChapterEnd,
  getDetectionOptions: getDetectionOptions,
  getLocalFilePath: getLocalFilePath,
  parseSeasonEpisode: parseSeasonEpisode,
  formatParsedSeasonEpisode: formatParsedSeasonEpisode,
  groupConnectedSections: groupConnectedSections,
  isPlainIntroChapterTitle: isPlainIntroChapterTitle,
  isAllowedTitleKind: isAllowedTitleKind,
  isSectionStartInRange: isSectionStartInRange,
  isSpecificIntroChapterTitle: isSpecificIntroChapterTitle,
  isVideoFilePath: isVideoFilePath,
  normalizeChapterTitle: normalizeChapterTitle,
};
