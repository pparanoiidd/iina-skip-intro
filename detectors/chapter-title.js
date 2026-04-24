const {
  SECTION_SOURCE_TITLE,
  classifyChapterTitle,
  getChapterStart,
  getDetectionOptions,
  groupConnectedSections,
  isAllowedTitleKind,
  isSectionStartInRange,
} = require('./shared.js');

const INTRO_MAX_START = 300;
const INTRO_MIN_DURATION = 15;
const INTRO_SINGLE_MAX_DURATION = 140;
const INTRO_COMBINED_MAX_DURATION = 240;

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

function detectSectionsFromChapterTitles(chapters, duration, options) {
  const resolvedOptions = getDetectionOptions(options);
  const titleSections = resolvedOptions.detectTitleSections
    ? collectSectionsFromChapterTitles(chapters, duration, resolvedOptions) || []
    : [];

  return groupConnectedSections(titleSections);
}

module.exports = {
  detectSectionsFromChapterTitles: detectSectionsFromChapterTitles,
};
