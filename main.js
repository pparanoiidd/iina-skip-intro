const core = iina.core;
const event = iina.event;
const mpv = iina.mpv;
const overlay = iina.overlay;
const preferences = iina.preferences;
const console = iina.console;

const INTRO_MAX_START = 300; // Intros must start within the first 5 minutes of the video
const INTRO_MAX_DURATION = 180;
const INTRO_MAX_START_RATIO = 0.25; // Intro must start within the first 25% of the video
const INTRO_PROMPT_AUTO_DISMISS_SECONDS = 10;
const PREF_PROGRESS_INDICATOR_STYLE = 'progress_indicator_style';
const PROGRESS_INDICATOR_FULL = 'full';
const PROGRESS_INDICATOR_BAR = 'bar';

let overlayReady = false;
let overlayVisible = false;
let dismissed = false;
let overlayInitialized = false;
let handlersRegistered = false;
let currentIntro = null;
let autoDismissTimer = null;

function log(message) {
  console.log('[Skip Intro] ' + message);
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

function normalizeChapterTitle(title) {
  if (typeof title !== 'string') return '';
  return title.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
}

function isIntroChapterTitle(title) {
  const normalized = normalizeChapterTitle(title);
  return (
    /^op\s*\d*$/.test(normalized) ||
    /^opening(?:\s+\d+|\s+(?:theme|song|credits))?$/.test(normalized) ||
    normalized === 'intro' ||
    normalized === 'title sequence' ||
    normalized === 'main title' ||
    /^ncop\s*\d*$/.test(normalized) ||
    /^non credit opening(?:\s+\d+)?$/.test(normalized)
  );
}

function detectIntroFromChapters(chapters, duration) {
  if (!Array.isArray(chapters) || chapters.length < 2) return null;
  if (typeof duration !== 'number' || !isFinite(duration) || duration <= 0) return null;

  for (var i = 0; i < chapters.length - 1; i++) {
    if (!isIntroChapterTitle(chapters[i].title)) continue;

    var start = getChapterStart(chapters[i]);
    if (start === null || start < 0) continue;
    if (start > INTRO_MAX_START || start > duration * INTRO_MAX_START_RATIO) continue;

    var endChapterIndex = i + 1;
    var titles = [chapters[i].title || ''];
    while (
      endChapterIndex < chapters.length &&
      isIntroChapterTitle(chapters[endChapterIndex].title)
    ) {
      titles.push(chapters[endChapterIndex].title || '');
      endChapterIndex++;
    }

    if (endChapterIndex >= chapters.length) continue;

    var end = getChapterStart(chapters[endChapterIndex]);
    if (end === null || end <= start) continue;
    if (end - start > INTRO_MAX_DURATION) continue;

    return {
      start: start,
      end: end,
      endChapterIndex: endChapterIndex,
      titles: titles,
    };
  }

  return null;
}

function detectCurrentIntro() {
  try {
    const duration = getDuration();
    const chapters = core.getChapters();
    currentIntro = detectIntroFromChapters(chapters, duration);
  } catch (error) {
    currentIntro = null;
    log('Chapter intro detection failed: ' + error);
  }

  if (currentIntro) {
    log(
      'Detected intro from ' +
        currentIntro.start.toFixed(2) +
        's to ' +
        currentIntro.end.toFixed(2) +
        's: ' +
        currentIntro.titles.join(', '),
    );
  } else {
    log('No chapter intro detected');
  }
}

function getProgressIndicatorStyle() {
  if (!preferences || typeof preferences.get !== 'function') {
    return PROGRESS_INDICATOR_FULL;
  }

  const style = preferences.get(PREF_PROGRESS_INDICATOR_STYLE);
  return style === PROGRESS_INDICATOR_BAR ? PROGRESS_INDICATOR_BAR : PROGRESS_INDICATOR_FULL;
}

function clearAutoDismissTimer() {
  if (autoDismissTimer === null) return;
  clearTimeout(autoDismissTimer);
  autoDismissTimer = null;
}

function startAutoDismissTimer() {
  clearAutoDismissTimer();
  autoDismissTimer = setTimeout(function () {
    autoDismissTimer = null;

    if (!overlayVisible || dismissed) return;

    log('Auto dismissed after ' + INTRO_PROMPT_AUTO_DISMISS_SECONDS + 's');
    dismissOverlay();
  }, INTRO_PROMPT_AUTO_DISMISS_SECONDS * 1000);
}

function dismissOverlay() {
  dismissed = true;
  setOverlayVisible(false);
}

function registerHandlers() {
  if (handlersRegistered) return;
  handlersRegistered = true;

  overlay.onMessage('skip', function () {
    if (!currentIntro) {
      log('Skip requested with no detected intro');
      dismissOverlay();
      return;
    }

    log('Skip requested - seeking to ' + currentIntro.end.toFixed(2) + 's');
    core.seekTo(currentIntro.end);
    dismissOverlay();
  });

  overlay.onMessage('dismiss', function () {
    log('Dismissed');
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

function sendState(visible) {
  overlay.postMessage('state', {
    visible: visible,
    introEnd: currentIntro ? currentIntro.end : null,
    autoDismissMs: INTRO_PROMPT_AUTO_DISMISS_SECONDS * 1000,
    progressIndicatorStyle: getProgressIndicatorStyle(),
  });
  overlayVisible = visible;
}

function setOverlayVisible(visible) {
  if (visible) {
    startAutoDismissTimer();
  } else {
    clearAutoDismissTimer();
  }

  sendState(visible);
  overlay.setClickable(visible);
}

function shouldShowOverlay(position) {
  return (
    !!currentIntro && !dismissed && position >= currentIntro.start && position < currentIntro.end
  );
}

function updateOverlay(position) {
  if (!overlayReady) return;
  if (typeof position !== 'number') {
    position = getPosition();
  }
  if (typeof position !== 'number' || !isFinite(position)) {
    return;
  }

  var show = shouldShowOverlay(position);
  if (show === overlayVisible) return;

  log((show ? 'Showing' : 'Hiding') + ' overlay at ' + position.toFixed(2) + 's');
  setOverlayVisible(show);
}

function resetState() {
  dismissed = false;
  currentIntro = null;
  if (overlayReady) {
    setOverlayVisible(false);
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
  detectCurrentIntro();
  updateOverlay();
});

event.on('mpv.end-file', function () {
  resetState();
});

event.on('mpv.time-pos.changed', function () {
  updateOverlay();
});

// Attempt init immediately in case window is already loaded
initializeOverlay();
