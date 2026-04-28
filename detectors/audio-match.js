const {
  SECTION_KIND_INTRO,
  SECTION_SOURCE_AUDIO_FINGERPRINT,
  formatParsedSeasonEpisode,
  getFilenameStem,
  getLocalFilePath,
  isVideoFilePath,
  parseSeasonEpisode,
} = require('./shared.js');

const AUDIO_MATCH_PLAYLIST_DELAY_MS = 500; // Delay to allow playlist properties to update
const AUDIO_MATCH_MAX_REFERENCE_FILES = 4;
const AUDIO_MATCH_HELPER_PATH = './vendor/audio-intro-match/iina-helper.mjs';
const PLUGIN_PACKAGE_NAME = 'com.pparanoiidd.skipintro.iinaplugin';
const PLUGIN_DEV_PACKAGE_NAME = 'com.pparanoiidd.skipintro.iinaplugin-dev';
const BAD_REFERENCE_FILENAME_REGEX =
  /(?:^|[\s._\-[\(])(?:sample|trailer|extras?|ncop\d*|nced\d*|oped|creditless|preview)(?:$|[\s._\-\]\)])/i;
const BINARY_CANDIDATES = Object.freeze({
  ffmpeg: ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'],
  node: ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'],
});

function createAudioMatchDetector(dependencies) {
  const mpv = dependencies.mpv;
  const file = dependencies.file;
  const iinaUtils = dependencies.utils;
  const delay = dependencies.delay;
  const log = dependencies.log;
  const binaryPathCache = Object.create(null);
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

  async function getAudioMatchDependencyStatus() {
    const missing = [];

    if (!(await locateBinary('node'))) {
      missing.push('node');
    }

    if (!(await locateBinary('ffmpeg'))) {
      missing.push('ffmpeg');
    }

    return {
      ok: missing.length === 0,
      missing: missing,
    };
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

  function getAudioMatchCacheDir() {
    try {
      return iinaUtils.resolvePath('@data/audio-intro-match-cache');
    } catch (error) {
      logAudio('feature cache disabled: failed to resolve @data path: ' + error);
      return null;
    }
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

  function normalizeComparablePath(value) {
    const localPath = getLocalFilePath(value);
    if (!localPath) return null;
    return localPath.replace(/\/+$/, '').toLowerCase();
  }

  function isPlayableLocalMedia(path) {
    return isVideoFilePath(path);
  }

  function isBadReferenceFilename(path) {
    return BAD_REFERENCE_FILENAME_REGEX.test(getFilenameStem(path));
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

    const nodePath = await locateBinary('node');
    if (!nodePath) {
      logAudio('skipped: node was not found');
      return null;
    }
    logAudio('using node: ' + nodePath);

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
    const cacheDir = getAudioMatchCacheDir();
    if (cacheDir) {
      args.push('--cache-dir', cacheDir);
    }

    logAudio('running helper with ' + refs.length + ' reference file(s)');
    const result = await iinaUtils.exec(nodePath, args);
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
    getAudioMatchDependencyStatus: getAudioMatchDependencyStatus,
  };
}

module.exports = {
  createAudioMatchDetector: createAudioMatchDetector,
};
