#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  DEFAULT_OPTIONS,
  IntroMatchError,
  MAX_REFERENCE_FILES,
  findIntroMatch,
} from '../lib/matcher.js';

const OPTION_PARSERS = {
  '--analyze-seconds': ['analyzeSeconds', parseInteger],
  '--sample-rate': ['sampleRate', parseInteger],
  '--min-intro': ['minIntro', parseInteger],
  '--max-intro': ['maxIntro', parseInteger],
  '--min-confidence': ['minConfidence', parseFloatValue],
};

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function parseInteger(flag, value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new IntroMatchError('INVALID_ARGUMENT', `Expected an integer for ${flag}.`, {
      flag,
      value,
    });
  }
  return parsed;
}

function parseFloatValue(flag, value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new IntroMatchError('INVALID_ARGUMENT', `Expected a number for ${flag}.`, {
      flag,
      value,
    });
  }
  return parsed;
}

function readOptionValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new IntroMatchError('INVALID_ARGUMENT', `Missing value for ${flag}.`, { flag });
  }
  return value;
}

function parseRefsJson(value) {
  let refs;
  try {
    refs = JSON.parse(value);
  } catch {
    throw new IntroMatchError('INVALID_ARGUMENT', 'Expected --refs-json to be a JSON array.');
  }

  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== 'string' || !ref)) {
    throw new IntroMatchError('INVALID_ARGUMENT', 'Expected --refs-json to contain file paths.');
  }
  return refs;
}

function parseArgs(argv) {
  const options = { ...DEFAULT_OPTIONS };
  let mainFile = null;
  let refFiles = [];
  let ffmpegPath = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const optionParser = OPTION_PARSERS[arg];
    if (optionParser) {
      const [optionKey, parser] = optionParser;
      options[optionKey] = parser(arg, readOptionValue(argv, index, arg));
      index += 1;
      continue;
    }

    if (arg === '--main') {
      mainFile = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === '--ref') {
      refFiles.push(readOptionValue(argv, index, arg));
      index += 1;
      continue;
    }

    if (arg === '--refs-json') {
      refFiles = parseRefsJson(readOptionValue(argv, index, arg));
      index += 1;
      continue;
    }

    if (arg === '--ffmpeg') {
      ffmpegPath = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    throw new IntroMatchError('INVALID_ARGUMENT', `Unknown argument: ${arg}`, { arg });
  }

  if (
    !mainFile ||
    !Array.isArray(refFiles) ||
    refFiles.length < 1 ||
    refFiles.length > MAX_REFERENCE_FILES
  ) {
    throw new IntroMatchError(
      'INVALID_FILE_COUNT',
      `Expected --main plus 1 to ${MAX_REFERENCE_FILES} refs.`,
      { mainFile, refFiles },
    );
  }

  return {
    mainFile,
    refFiles,
    options,
    commandPaths: {
      ...(ffmpegPath ? { ffmpeg: ffmpegPath } : {}),
    },
  };
}

function validateFiles(paths) {
  for (const path of paths) {
    if (!existsSync(path)) {
      throw new IntroMatchError('FILE_NOT_FOUND', `File not found: ${path}`, { path });
    }
  }
}

function createRunCommand(commandPaths) {
  return function runCommand({ command, args, stdoutMode = 'text' }) {
    const executable = commandPaths[command] || command;

    return spawnCommand({
      command: executable,
      args,
      stdoutMode,
    });
  };
}

function spawnCommand({ command, args, stdoutMode = 'text' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    child.on('error', (error) => {
      error.command = command;
      reject(error);
    });

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk);
    });

    child.on('close', (code) => {
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      resolve({
        code: code ?? 1,
        stdout:
          stdoutMode === 'bytes' ? new Uint8Array(stdoutBuffer) : stdoutBuffer.toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

function compactOutput(output) {
  return {
    accepted: output.accepted,
    intro: output.intro,
    shared_audio: output.shared_audio,
    confidence: output.confidence,
    scores: output.scores,
    reference_matches: output.reference_matches,
  };
}

function serializeError(error) {
  if (error instanceof IntroMatchError) {
    const payload = {
      ok: false,
      code: error.code,
      message: error.message,
      details: error.details,
    };

    const output = error.details?.output;
    if (output) {
      payload.output = compactOutput(output);
      delete payload.details.output;
    }

    return payload;
  }

  return {
    ok: false,
    code: 'UNEXPECTED_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}

async function main() {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    validateFiles([parsed.mainFile, ...parsed.refFiles]);

    const output = await findIntroMatch({
      mainFile: parsed.mainFile,
      refFiles: parsed.refFiles,
      options: parsed.options,
      runCommand: createRunCommand(parsed.commandPaths),
    });

    printJson({
      ok: true,
      output: compactOutput(output),
    });
  } catch (error) {
    printJson(serializeError(error));
    process.exitCode = error instanceof IntroMatchError ? 0 : 1;
  }
}

main();
