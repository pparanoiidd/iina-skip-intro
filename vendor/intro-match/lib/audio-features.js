import { safeLog10 } from './math.js';

export const MEL_BANDS = 32;

let fftWorkReal = null;
let fftWorkImag = null;
let fftWorkPowers = null;
const hannWindowCache = new Map();
const melFiltersCache = new Map();

function getHannWindow(length) {
  if (!hannWindowCache.has(length)) {
    const win = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (length - 1)));
    }
    hannWindowCache.set(length, win);
  }
  return hannWindowCache.get(length);
}

export function fftIterative(real, imag) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = real[i];
      real[i] = real[j];
      real[j] = tr;
      const ti = imag[i];
      imag[i] = imag[j];
      imag[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wlenR = Math.cos(angle);
    const wlenI = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wR = 1;
      let wI = 0;
      for (let j = 0; j < halfLen; j += 1) {
        const tr = real[i + j + halfLen] * wR - imag[i + j + halfLen] * wI;
        const ti = real[i + j + halfLen] * wI + imag[i + j + halfLen] * wR;
        real[i + j + halfLen] = real[i + j] - tr;
        imag[i + j + halfLen] = imag[i + j] - ti;
        real[i + j] += tr;
        imag[i + j] += ti;
        const nextWR = wR * wlenR - wI * wlenI;
        wI = wR * wlenI + wI * wlenR;
        wR = nextWR;
      }
    }
  }
}

function getMelFilterBank(sampleRate, fftSize, numBands, minFreq, maxFreq) {
  const minMel = 2595 * Math.log10(1 + minFreq / 700);
  const maxMel = 2595 * Math.log10(1 + maxFreq / 700);
  const melPoints = new Float32Array(numBands + 2);
  for (let i = 0; i < numBands + 2; i += 1) {
    melPoints[i] = minMel + (i * (maxMel - minMel)) / (numBands + 1);
  }
  const freqPoints = melPoints.map((mel) => 700 * (10 ** (mel / 2595) - 1));
  const binPoints = freqPoints.map((f) => Math.floor(((fftSize + 1) * f) / sampleRate));

  const filters = [];
  for (let i = 0; i < numBands; i += 1) {
    const start = binPoints[i];
    const mid = binPoints[i + 1];
    const end = binPoints[i + 2];
    filters.push({
      start,
      mid,
      end,
      riseDivisor: Math.max(1, mid - start),
      fallDivisor: Math.max(1, end - mid),
    });
  }
  return filters;
}

function getCachedMelFilters(sampleRate, fftSize) {
  const key = `${sampleRate}:${fftSize}`;
  if (!melFiltersCache.has(key)) {
    melFiltersCache.set(key, getMelFilterBank(sampleRate, fftSize, MEL_BANDS, 80, 3400));
  }
  return melFiltersCache.get(key);
}

export function frameFeatures(samples, sampleRate) {
  if (!samples.length) {
    return {
      mel: new Float32Array(MEL_BANDS),
      rmsDb: -120.0,
    };
  }

  const sampleCount = samples.length;
  let squaredSum = 0.0;
  for (const sample of samples) {
    squaredSum += sample * sample;
  }
  const rms = Math.sqrt(squaredSum / sampleCount);
  const rmsDb = 20.0 * safeLog10(rms / 32768.0);

  const fftSize = 1 << Math.ceil(Math.log2(sampleCount));
  if (!fftWorkReal || fftWorkReal.length !== fftSize) {
    fftWorkReal = new Float32Array(fftSize);
    fftWorkImag = new Float32Array(fftSize);
    fftWorkPowers = new Float32Array(fftSize / 2 + 1);
  } else {
    fftWorkReal.fill(0);
    fftWorkImag.fill(0);
  }

  const win = getHannWindow(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    fftWorkReal[i] = samples[i] * win[i];
  }

  fftIterative(fftWorkReal, fftWorkImag);

  const half = fftSize / 2;
  for (let i = 0; i <= half; i += 1) {
    fftWorkPowers[i] = fftWorkReal[i] ** 2 + fftWorkImag[i] ** 2;
  }

  const filters = getCachedMelFilters(sampleRate, fftSize);
  const mel = new Float32Array(filters.length);
  let melTotal = 0.0;
  for (let band = 0; band < filters.length; band += 1) {
    const filter = filters[band];
    let power = 0.0;
    for (let i = filter.start; i < filter.mid; i += 1) {
      power += fftWorkPowers[i] * ((i - filter.start) / filter.riseDivisor);
    }
    for (let i = filter.mid; i < filter.end; i += 1) {
      power += fftWorkPowers[i] * ((filter.end - i) / filter.fallDivisor);
    }
    const logPower = safeLog10(power + 1.0);
    mel[band] = logPower;
    melTotal += logPower;
  }

  const melMean = melTotal / mel.length;
  for (let i = 0; i < mel.length; i += 1) {
    mel[i] -= melMean;
  }

  return { mel, rmsDb };
}
