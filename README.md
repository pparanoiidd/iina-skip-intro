<h1 align="center">Skip Intro plugin for IINA</h1>

<p align="center">
Skip Intro adds intro, recap and credits skipping to <a href="https://iina.io/">IINA</a>, the modern media player for macOS.
</p>

<p align="center">
<a href="#features">Features</a> ·
<a href="#installation">Installation</a> ·
<a href="#screenshots">Screenshots</a> ·
<a href="#detection-methods">Detection Methods</a> ·
<a href="#preferences">Preferences</a>
</p>

---

It detects sections through 3 different methods: chapter titles, audio fingerprint analysis, or chapter timings, then either shows a skip pop-up or auto-skips based on your preferences.

## Features

- Skip prompts for intros, recaps and credits.
- Uses 3 different detection methods: chapter titles, audio fingerprint analysis and chapter timings
- Optional Auto-Skip for mouse free skipping.
- Customise to your needs through the preferences page.
- White or grey pop-up style options.

## Installation

### Recommended Audio Matching Dependencies

> [!IMPORTANT]
> **Optional but recommended:** Install Node.js and ffmpeg to enable audio fingerprint detection.
> If audio matching is enabled and either dependency is missing, the plugin shows a warning and logs the missing dependency, but otherwise still works.

Install them with Homebrew from Terminal:

```console
brew install node ffmpeg
```

### Install the Plugin

1. Install [IINA](https://iina.io/) on macOS.
2. Open IINA, then go to `Settings -> Plugins` from the menu bar.
3. Choose `Install from GitHub...`.
4. Paste `pparanoiidd/iina-skip-intro` and install.
   > **Note:** See [Permissions](#permissions) for why the plugin asks for each permission.
5. Restart IINA.
6. Open `Settings -> Plugins -> Skip Intro -> Preferences` to tweak settings.

## Screenshots

## Detection Methods

Detection methods run in this order and stop after the first match. You can disable any method you do not want running in Preferences.

### Chapter Title Detection

Uses chapter names such as `Intro`, `OP`, `Opening`, `Recap`, `Previously On`, `Credits`, `ED`, and related variants. This is the fastest and most reliable method when the file has useful chapters.

Title-detected intros must start near the beginning of the video and have a reasonable duration. Credits are only accepted near the end of the video, with duration limits scaled by runtime.

### Audio Fingerprint Detection

Compares the current episode with nearby playlist episodes and looks for shared audio that appears in the same broad region. This is intended for shows where episodes share the same intro but do not have helpful chapter titles.

The matcher:

- Selects up to 4 reference files from the current playlist.
- Prefers same-season neighboring episodes when season and episode numbers can be parsed from filenames (e.g. S02E11).
- Falls back to nearby playlist items when filename parsing is unavailable or disabled.
- Analyzes the early part of each episode and refines boundaries.
- Caches extracted audio features so repeat scans are faster.

By default, audio matching looks for intro-length shared audio between 20 and 150 seconds long and requires a confidence threshold before accepting a match.

### Chapter Timing Detection

Uses chapter structure as a lower-confidence fallback. It looks for an early chapter with intro-like duration followed by a much longer chapter, then scores candidates by position, duration and next-chapter dominance.

This method can misfire, so it is disabled by default.

## Scan Limits

- Detection only runs for video files that are at least 10 minutes long.
- Videos longer than 90 minutes are treated as movie-length media. For those files, the plugin only allows credit detection from chapter titles.
- Audio fingerprint matching analyzes the early portion of an episode and accepts shared intro candidates from 20 to 150 seconds long.

## Preferences

Intro detection methods:

- `Chapter title detection`: enable or disable title-based chapter scanning.
- `Chapter title intros`: Off, Prompt, or Auto-Skip.
- `Chapter title recaps`: Off, Prompt, or Auto-Skip.
- `Chapter title credits`: Off, Prompt, or Auto-Skip.
- `Audio fingerprint detection`: enable or disable audio matching.
- `Audio fingerprint intros`: Prompt or Auto-Skip.
- `Use season and episode numbers from filenames`: helps audio matching choose better reference episodes.
- `Chapter timing detection`: enable or disable the fallback timing heuristic.

Skip pop-up:

- `Auto hide after`: 5 to 20 seconds.
- `Leave at end`: 0 to 10 seconds before the detected section end.
- `Skip button style`: White or Grey.

Auto-Skip:

- `Auto-Skip delay`: 0 to 10 seconds after the detected section starts.
- `Show Auto-Skip status pop-up`: show pending and complete status while auto-skipping.
- `Auto-Skip first episode of the season`: allow or prevent automatic intro skipping on episode 1 of a season.

## Troubleshooting

If the plugin is not working as expected, check IINA's logs:

- Open logs with `Ctrl + Cmd + L`.
- Set `Subsystem` to `Skip Intro`.

Useful things to look for:

- Missing `node` or `ffmpeg` warnings.
- Audio detection messages about playlist references, helper lookup, confidence, or rejected matches.

The plugin checks for audio matching dependencies in these locations:

- `ffmpeg`: `/opt/homebrew/bin/ffmpeg`, `/usr/local/bin/ffmpeg`
- `node`: `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node`

Audio fingerprint detection is not perfect. It works best when nearby episodes share the same intro audio and are loaded together in the playlist. It may miss intros with major audio changes, unusual episode ordering, poor filename parsing, or too few neighbouring reference episodes.

## Permissions

The plugin requests:

- `video-overlay` to render the skip prompt over the video.
- `file-system` to find the bundled audio matcher, inspect local playlist items, check for dependencies, and use the audio feature cache.
- `show-osd` to show a warning when audio matching dependencies are missing.
