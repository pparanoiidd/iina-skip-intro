const {
  SECTION_KIND_INTRO,
  SECTION_KIND_CREDITS,
  SECTION_SOURCE_TITLE,
  classifyChapterTitle,
  getChapterStart,
  getDetectionOptions,
  isAllowedTitleKind,
  isPlainIntroChapterTitle,
  isSectionStartInRange,
  isSpecificIntroChapterTitle,
} = require('./shared.js');

const INTRO_MAX_START = 300;
const INTRO_MIN_DURATION = 15;
const INTRO_MAX_DURATION = 140;

const CREDITS_MIN_DURATION = 30;
const CREDITS_MIN_RUNTIME = 15 * 60;
const CREDITS_MAX_RUNTIME = 3 * 60 * 60;
const CREDITS_MIN_END_DISTANCE = 3 * 60;
const CREDITS_MAX_END_DISTANCE = 15 * 60;
const CREDITS_MIN_MAX_DURATION = 2.5 * 60;
const CREDITS_MAX_MAX_DURATION = 14 * 60;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function scaleByRuntime(duration, minValue, maxValue) {
  const runtimeRatio = clamp(
    (duration - CREDITS_MIN_RUNTIME) / (CREDITS_MAX_RUNTIME - CREDITS_MIN_RUNTIME),
    0,
    1,
  );
  return minValue + (maxValue - minValue) * runtimeRatio;
}

function getCreditsMaxEndDistance(duration) {
  return scaleByRuntime(duration, CREDITS_MIN_END_DISTANCE, CREDITS_MAX_END_DISTANCE);
}

function getCreditsMaxDuration(duration) {
  return scaleByRuntime(duration, CREDITS_MIN_MAX_DURATION, CREDITS_MAX_MAX_DURATION);
}

function isValidTitleSection(start, end, duration) {
  if (start === null || !isSectionStartInRange(start, duration, INTRO_MAX_START)) return false;
  if (end === null || end <= start) return false;

  const sectionDuration = end - start;
  return sectionDuration >= INTRO_MIN_DURATION && sectionDuration <= INTRO_MAX_DURATION;
}

function isValidCreditsTitleSection(start, end, duration) {
  if (start === null || end === null || end <= start) return false;
  if (end > duration + 1) return false;

  const sectionDuration = end - start;
  const distanceFromEnd = duration - start;
  return (
    start >= 0 &&
    sectionDuration >= CREDITS_MIN_DURATION &&
    sectionDuration <= getCreditsMaxDuration(duration) &&
    distanceFromEnd <= getCreditsMaxEndDistance(duration)
  );
}

function hasLaterSpecificIntroChapterTitle(chapters, index, options) {
  for (let i = index + 1; i < chapters.length; i++) {
    if (isSpecificIntroChapterTitle(chapters[i].title, options)) {
      return true;
    }
  }
  return false;
}

function collectSectionsFromChapterTitles(chapters, duration, options) {
  if (!Array.isArray(chapters) || chapters.length < 2) return [];
  if (typeof duration !== 'number' || !isFinite(duration) || duration <= 0) return [];

  const sections = [];
  for (let i = 0; i < chapters.length; ) {
    const kind = classifyChapterTitle(chapters[i].title, options);
    if (!isAllowedTitleKind(kind, options)) {
      i++;
      continue;
    }
    if (
      kind === SECTION_KIND_INTRO &&
      isPlainIntroChapterTitle(chapters[i].title) &&
      hasLaterSpecificIntroChapterTitle(chapters, i, options)
    ) {
      i++;
      continue;
    }

    const titles = [chapters[i].title || ''];
    const start = getChapterStart(chapters[i]);
    let end = i + 1 < chapters.length ? getChapterStart(chapters[i + 1]) : duration;
    // Trimmed files can retain a credits-end marker beyond their actual runtime.
    if (kind === SECTION_KIND_CREDITS && end !== null) end = Math.min(end, duration);
    const isValid =
      kind === SECTION_KIND_CREDITS
        ? isValidCreditsTitleSection(start, end, duration)
        : isValidTitleSection(start, i + 1 < chapters.length ? end : null, duration);

    if (isValid) {
      sections.push({
        id: 'section-' + (sections.length + 1),
        start: start,
        end: end,
        titles: titles,
        source: SECTION_SOURCE_TITLE,
        kind: kind,
      });
    }

    i++;
  }

  return sections;
}

function detectSectionsFromChapterTitles(chapters, duration, options) {
  const resolvedOptions = getDetectionOptions(options);
  return resolvedOptions.detectTitleSections
    ? collectSectionsFromChapterTitles(chapters, duration, resolvedOptions)
    : [];
}

module.exports = {
  detectSectionsFromChapterTitles: detectSectionsFromChapterTitles,
};
