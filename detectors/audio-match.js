const { SECTION_KIND_INTRO, SECTION_SOURCE_AUDIO_FINGERPRINT } = require('./shared.js');

const AUDIO_MATCH_PLAYLIST_DELAY_MS = 700; // Delay to allow playlist properties to update
const AUDIO_MATCH_MAX_REFERENCE_FILES = 4;
const AUDIO_MATCH_HELPER_PATH = './vendor/audio-intro-match/iina-helper.mjs';
const PLUGIN_PACKAGE_NAME = 'com.pparanoiidd.skipintro.iinaplugin';
const PLUGIN_DEV_PACKAGE_NAME = 'com.pparanoiidd.skipintro.iinaplugin-dev';
const MEDIA_FILE_EXTENSION_REGEX =
  /\.(?:3g2|3gp|avi|flv|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|ogm|ogv|rmvb|ts|webm|wmv)$/i;
const BAD_REFERENCE_FILENAME_REGEX =
  /(?:^|[\s._\-[\(])(?:sample|trailer|extras?|ncop\d*|nced\d*|oped|creditless|preview)(?:$|[\s._\-\]\)])/i;
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
const BINARY_CANDIDATES = Object.freeze({
  ffmpeg: ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'],
  node: ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'],
  bun: ['/opt/homebrew/bin/bun', '/usr/local/bin/bun', '~/.bun/bin/bun'],
});

function createAudioMatchDetector(dependencies) {
  const mpv = dependencies.mpv;
  const file = dependencies.file;
  const iinaUtils = dependencies.utils;
  const delay = dependencies.delay;
  const log = dependencies.log;
  const binaryPathCache = Object.create(null);
  let audioRuntimePath = undefined;
  let homeDirectory = undefined;

  function logAudio(message) {
    log('Audio intro detection: ' + message);
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

  function buildPlaylistReferenceCandidates(items, currentIndex, shouldParseEpisodeNumbers) {
    const candidates = [];
    for (let i = 0; i < items.length; i++) {
      const path = getPlaylistItemPath(items[i]);
      if (i === currentIndex || !isPlayableLocalMedia(path) || isBadReferenceFilename(path)) {
        continue;
      }

      const parsed = shouldParseEpisodeNumbers ? parseSeasonEpisode(path) : null;
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

  function sortByPlaylistDistance(currentIndex) {
    return function (a, b) {
      const aDistance = Math.abs(a.index - currentIndex);
      const bDistance = Math.abs(b.index - currentIndex);
      const aPrevious = a.index < currentIndex ? 0 : 1;
      const bPrevious = b.index < currentIndex ? 0 : 1;

      return aDistance - bDistance || aPrevious - bPrevious || a.index - b.index;
    };
  }

  function sortByEpisodeOffset(currentEpisode) {
    return function (a, b) {
      const aOffset = a.parsed.episode - currentEpisode;
      const bOffset = b.parsed.episode - currentEpisode;
      const aDistance = Math.abs(aOffset);
      const bDistance = Math.abs(bOffset);
      const aSide = aOffset > 0 ? 0 : 1;
      const bSide = bOffset > 0 ? 0 : 1;

      return aDistance - bDistance || aSide - bSide || a.index - b.index;
    };
  }

  function isSameSeasonReference(candidate, currentParsed) {
    return (
      candidate.parsed &&
      !candidate.parsed.isSpecial &&
      candidate.parsed.season === currentParsed.season &&
      candidate.parsed.episode !== currentParsed.episode
    );
  }

  function getSameSeasonEpisodeRun(candidates, currentIndex, itemCount, currentParsed) {
    const candidateByIndex = Object.create(null);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (isSameSeasonReference(candidate, currentParsed)) {
        candidateByIndex[candidate.index] = candidate;
      }
    }

    const run = [];
    let previousEpisode = currentParsed.episode;
    for (let previousIndex = currentIndex - 1; previousIndex >= 0; previousIndex--) {
      const candidate = candidateByIndex[previousIndex];
      if (!candidate) break;
      if (candidate.parsed.episode >= previousEpisode) break;
      run.push(candidate);
      previousEpisode = candidate.parsed.episode;
    }

    let nextEpisode = currentParsed.episode;
    for (let nextIndex = currentIndex + 1; nextIndex < itemCount; nextIndex++) {
      const candidate = candidateByIndex[nextIndex];
      if (!candidate) break;
      if (candidate.parsed.episode <= nextEpisode) break;
      run.push(candidate);
      nextEpisode = candidate.parsed.episode;
    }

    return run;
  }

  function shouldParseEpisodeNumbers(options) {
    return !options || options.parseAudioMatchEpisodeNumbers !== false;
  }

  function getAudioReferenceFiles(mainFile, options) {
    const items = getPlaylistItems();
    const currentIndex = getCurrentPlaylistIndex(items, mainFile);
    if (currentIndex < 0) {
      logAudio('playlist scan: ' + items.length + ' item(s), no current item found');
      return [];
    }

    const currentPath = getPlaylistItemPath(items[currentIndex]) || mainFile;
    const parseEpisodeNumbers = shouldParseEpisodeNumbers(options);
    const currentParsed = parseEpisodeNumbers ? parseSeasonEpisode(currentPath) : null;
    const candidates = buildPlaylistReferenceCandidates(items, currentIndex, parseEpisodeNumbers);
    logAudio(
      'playlist scan: ' +
        items.length +
        ' item(s), current index ' +
        currentIndex +
        ', current ' +
        (parseEpisodeNumbers ? formatParsedSeasonEpisode(currentParsed) : 'playlist-order only'),
    );
    let selected = [];

    if (currentParsed && !currentParsed.isSpecial) {
      selected = getSameSeasonEpisodeRun(
        candidates,
        currentIndex,
        items.length,
        currentParsed,
      ).sort(sortByEpisodeOffset(currentParsed.episode));
      logAudio(
        'reference candidates: ' +
          candidates.length +
          ' usable, ' +
          selected.length +
          ' same-season in current episode run',
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

  async function detectSectionFromAudioMatch(options) {
    logAudio('waiting ' + AUDIO_MATCH_PLAYLIST_DELAY_MS + 'ms before reading playlist');
    await delay(AUDIO_MATCH_PLAYLIST_DELAY_MS);

    const mainFile = getCurrentMediaFile();
    const referenceFiles = getAudioReferenceFiles(mainFile, options);

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

  return {
    detectSectionFromAudioMatch: detectSectionFromAudioMatch,
  };
}

module.exports = {
  createAudioMatchDetector: createAudioMatchDetector,
};
