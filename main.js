const core = iina.core;
const event = iina.event;
const overlay = iina.overlay;
const console = iina.console;

const INTRO_START = 30;
const INTRO_END = 120;

let overlayReady = false;
let overlayVisible = false;
let dismissed = false;
let overlayInitialized = false;
let handlersRegistered = false;

function log(message) {
  console.log('[Skip Intro] ' + message);
}

function getPosition() {
  return typeof core.status.position === 'number' ? core.status.position : 0;
}

function dismissOverlay() {
  dismissed = true;
  setOverlayVisible(false);
}

function registerHandlers() {
  if (handlersRegistered) return;
  handlersRegistered = true;

  overlay.onMessage('skip', function () {
    log('Skip requested - seeking to ' + INTRO_END);
    core.seekTo(INTRO_END);
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
    introEnd: INTRO_END,
  });
  overlayVisible = visible;
}

function setOverlayVisible(visible) {
  if (visible) overlay.show();
  sendState(visible);
  overlay.setOpacity(visible ? 1 : 0);
  overlay.setClickable(visible);
  if (!visible) overlay.hide();
}

function shouldShowOverlay(position) {
  return !dismissed && position >= INTRO_START && position < INTRO_END;
}

function updateOverlay(position) {
  if (!overlayReady) return;
  if (typeof position !== 'number') {
    position = getPosition();
  }
  var show = shouldShowOverlay(position);
  if (show === overlayVisible) return;

  log((show ? 'Showing' : 'Hiding') + ' overlay at ' + position.toFixed(2) + 's');
  setOverlayVisible(show);
}

function resetState() {
  dismissed = false;
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
  registerHandlers();
  setOverlayVisible(false);
  updateOverlay();
});

event.on('mpv.file-loaded', function () {
  log('File loaded');
  resetState();
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
