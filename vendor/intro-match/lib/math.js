export function mean(values) {
  if (!values.length) {
    return 0.0;
  }
  let total = 0.0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

export function median(values) {
  if (!values.length) {
    return 0.0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function clamp(value, lower, upper) {
  return Math.max(lower, Math.min(upper, value));
}

export function safeLog10(value, floor = 1e-12) {
  return Math.log10(Math.max(value, floor));
}

export function round4(value) {
  return Number(value.toFixed(4));
}

export function secondsToHms(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function cosineSim(a, b) {
  let num = 0.0;
  let da = 0.0;
  let db = 0.0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index];
    const y = b[index];
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da <= 1e-12 || db <= 1e-12) {
    return 0.0;
  }
  return num / Math.sqrt(da * db);
}

export function dotProduct(a, b) {
  let total = 0.0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    total += a[index] * b[index];
  }
  return total;
}

export function l2Normalize(values) {
  let sumSquares = 0.0;
  for (const value of values) {
    sumSquares += value * value;
  }
  if (sumSquares <= 1e-12) {
    return values.map(() => 0.0);
  }
  const scale = 1 / Math.sqrt(sumSquares);
  return values.map((value) => value * scale);
}

export function stddev(values, avg = mean(values)) {
  if (!values.length) {
    return 0.0;
  }
  let variance = 0.0;
  for (const value of values) {
    variance += (value - avg) ** 2;
  }
  return Math.sqrt(variance / values.length);
}

export function melContrast(values) {
  if (!values.length) {
    return 0.0;
  }
  const average = mean(values);
  return stddev(values, average);
}

export function robustNormalizeColumns(rows) {
  if (!rows.length) {
    return rows;
  }

  const columnCount = rows[0].length;
  const means = [];
  const stddevs = [];

  for (let column = 0; column < columnCount; column += 1) {
    const values = rows.map((row) => row[column]);
    const average = mean(values);
    let variance = 0.0;
    for (const val of values) {
      variance += (val - average) ** 2;
    }
    variance /= values.length;
    means.push(average);
    stddevs.push(variance > 1e-12 ? Math.sqrt(variance) : 1.0);
  }

  return rows.map((row) => row.map((value, index) => (value - means[index]) / stddevs[index]));
}

export function prefixSums(values) {
  const prefix = new Float64Array(values.length + 1);
  for (let index = 0; index < values.length; index += 1) {
    prefix[index + 1] = prefix[index] + values[index];
  }
  return prefix;
}

export function rangeMean(prefix, start, end) {
  const length = end - start;
  if (length <= 0) {
    return 0.0;
  }
  return (prefix[end] - prefix[start]) / length;
}

export function lexicographicDescending(keysA, keysB) {
  for (let index = 0; index < keysA.length; index += 1) {
    if (keysA[index] > keysB[index]) {
      return -1;
    }
    if (keysA[index] < keysB[index]) {
      return 1;
    }
  }
  return 0;
}
