const {
  SECTION_KIND_INTRO,
  SECTION_KIND_RECAP,
  SECTION_KIND_SECTION,
  SECTION_SOURCE_TIMING,
  classifyChapterTitle,
  getChapterEnd,
  getChapterStart,
  getDetectionOptions,
  groupConnectedSections,
  isSectionStartInRange,
} = require('./shared.js');

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

function detectSectionsFromChapterTiming(chapters, duration, options) {
  const resolvedOptions = getDetectionOptions(options);
  const timingSection = resolvedOptions.detectTimingSections
    ? detectSectionFromChapterTiming(chapters, duration, resolvedOptions)
    : null;

  return timingSection ? groupConnectedSections([timingSection]) : [];
}

module.exports = {
  detectSectionsFromChapterTiming: detectSectionsFromChapterTiming,
};
