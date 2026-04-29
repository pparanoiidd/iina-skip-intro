<h1 align="center">Skip Intro plugin for IINA</h1>

<p align="center">
Skip Intro adds intro, recap and credits skipping to <a href="https://iina.io/">IINA</a>, the modern media player for macOS.
</p>

<p align="center">
<a href="#features">Features</a> ·
<a href="#screenshots">Screenshots</a> ·
<a href="#installation">Installation</a> ·
<a href="#detection-methods">Detection Methods</a> ·
<a href="#troubleshooting">Troubleshooting</a>
</p>

---

It detects sections through three different methods: chapter titles, audio fingerprint analysis, or chapter timings, then either shows a skip pop-up or auto-skips based on your preferences.

## Features

- Skip prompts for intros, recaps and credits.
- Uses three detection methods: chapter titles, audio fingerprint analysis and chapter timings.
- Optional Auto-Skip for mouse-free skipping.
- Customize detection and skip behavior through the preferences page.
- Configurable skip pop-up timeout, end buffer, button styling and more.

## Screenshots

## Installation

### Optional: Enable Audio Fingerprint Matching

> [!IMPORTANT]
> Audio fingerprint matching is an advanced optional feature.
> Many shows do not include useful chapter titles, so audio matching greatly expands the media files this plugin can support when episodes reuse the same intro audio.

#### Prerequisites

Audio fingerprint matching requires:

- Node.js
- FFmpeg

Installing them with Homebrew:

If you do not have Homebrew installed, install it from [brew.sh](https://brew.sh/) first, following the instructions shown by the Homebrew installer.

Then paste this in your Terminal to install the prerequisites:

```console
brew install node ffmpeg
```

### Install the Plugin

1. Install and open [IINA](https://iina.io/), then go to `Settings -> Plugins` from the menu bar.
2. Choose `Install from GitHub...`.
3. Paste `pparanoiidd/iina-skip-intro` and install.
   > **Note:** See [Permissions](#permissions) for why the plugin asks for each permission.
4. Restart IINA.
5. Open `Settings -> Plugins -> Skip Intro -> Preferences` to choose detection methods and skip behavior.

## Detection Methods

Detection methods run in this order and stop after the first match. By default, only chapter title detection is enabled. You can enable or disable any method in Preferences.

### Chapter Title Detection

Uses chapter names such as `Intro`, `OP`, `Opening`, `Recap`, `Previously On`, `Credits`, `ED`, and related variants. This is the fastest and most reliable method when the file has useful chapters.

Title-detected intros must start near the beginning of the video and have a reasonable duration. Credits are only accepted near the end of the video, with duration limits scaled by runtime.

For chapter title matches, intros, recaps and credits can each be set to Off, Prompt or Auto-Skip.

### Audio Fingerprint Detection

Compares the current episode with nearby playlist episodes and looks for shared audio that appears in the same broad region. This is intended for shows where episodes share the same intro but do not have helpful chapter titles.

The matcher:

- Selects up to 4 reference files from the current playlist.
- Prefers same-season neighboring episodes when season and episode numbers can be parsed from filenames (e.g. S02E11).
- Falls back to nearby playlist items when filename parsing is unavailable or disabled.
- Analyzes the early part of each episode and refines boundaries.
- Caches extracted audio features so repeat scans are faster.

When enabled, audio matching looks for intro-length shared audio between 20 and 150 seconds long and requires a confidence threshold before accepting a match. It is disabled by default because it is an advanced optional feature and requires Node.js and FFmpeg.

### Chapter Timing Detection

Uses chapter structure as a lower-confidence fallback. It looks for an early chapter with intro-like duration followed by a much longer chapter, then scores candidates by position, duration and next-chapter dominance.

This method can misfire, so it is disabled by default.

## Scan Limits

- Detection only runs for video files that are at least 10 minutes long.
- Videos longer than 90 minutes are treated as movie-length media. For those files, the plugin only allows credit detection from chapter titles.
- Audio fingerprint matching analyzes the early portion of an episode and accepts shared intro candidates from 20 to 150 seconds long.

## Troubleshooting

If the plugin is not working as expected, check IINA's logs:

1. Open `Settings -> Advanced`.
2. Enable `Advanced settings`.
3. Enable `Logging` and restart.
4. Play the problem video so the plugin can run and write log entries.
5. Open logs with `Ctrl + Cmd + L`.
6. Set `Subsystem` to `Skip Intro`.

Useful things to look for:

- Missing `node` or `ffmpeg` warnings. See [Optional: Enable Audio Fingerprint Matching](#optional-enable-audio-fingerprint-matching) for setup instructions.
- Audio detection messages about playlist references, helper lookup, confidence, or rejected matches.

The plugin checks for audio matching dependencies in these locations:

- `ffmpeg`: `/opt/homebrew/bin/ffmpeg`, `/usr/local/bin/ffmpeg`
- `node`: `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node`

Audio fingerprint detection is not perfect. It works best when nearby episodes share the same intro audio and are loaded together in the playlist. It may miss intros with unusual episode ordering, poor filename parsing, too few neighbouring reference episodes or even humanly inaudible audio differences.

## Permissions

The plugin requests:

- `file-system` to find the bundled audio matcher, inspect local playlist items, check for dependencies, and use the audio feature cache.
- `video-overlay` to render the skip prompt over the video.
