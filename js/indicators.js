// indicators.js
// Pure technical-analysis math. Every function takes plain number arrays and
// returns arrays aligned to the input length (leading values are `null` until
// the indicator has enough data to be defined). No dependencies.

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) {
      // seed with an SMA of the first `period` values
      let sum = 0;
      for (let j = 0; j < period; j++) sum += values[j];
      prev = sum / period;
      out[i] = prev;
    } else if (i >= period) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

// Wilder's smoothing (used by RSI, ATR, ADX)
function wilderSmooth(values, period) {
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) continue;
    if (prev == null) {
      // find first window
      const slice = values.slice(0, i + 1).filter((v) => v != null);
      if (slice.length >= period) {
        let sum = 0;
        for (let j = 0; j < period; j++) sum += slice[j];
        prev = sum / period;
        out[i] = prev;
      }
    } else {
      prev = (prev * (period - 1) + values[i]) / period;
      out[i] = prev;
    }
  }
  return out;
}

export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  const gains = new Array(closes.length).fill(0);
  const losses = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains[i] = diff > 0 ? diff : 0;
    losses[i] = diff < 0 ? -diff : 0;
  }
  let avgGain = null;
  let avgLoss = null;
  for (let i = 1; i < closes.length; i++) {
    if (i < period) continue;
    if (avgGain == null) {
      let g = 0;
      let l = 0;
      for (let j = 1; j <= period; j++) {
        g += gains[j];
        l += losses[j];
      }
      avgGain = g / period;
      avgLoss = l / period;
    } else {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  // signal line = EMA of the macd line (only over its defined region)
  const defined = macdLine.map((v) => (v == null ? 0 : v));
  const firstIdx = macdLine.findIndex((v) => v != null);
  const signalRaw = ema(defined.slice(firstIdx), signalPeriod);
  const signalLine = new Array(closes.length).fill(null);
  for (let i = 0; i < signalRaw.length; i++) {
    if (signalRaw[i] != null) signalLine[firstIdx + i] = signalRaw[i];
  }
  const histogram = macdLine.map((v, i) =>
    v != null && signalLine[i] != null ? v - signalLine[i] : null
  );
  return { macdLine, signalLine, histogram };
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(sum / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { upper, mid, lower };
}

export function stochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  const k = new Array(closes.length).fill(null);
  for (let i = kPeriod - 1; i < closes.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    k[i] = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
  }
  const d = sma(k.map((v) => (v == null ? 0 : v)), dPeriod).map((v, i) =>
    k[i] == null ? null : v
  );
  return { k, d };
}

export function atr(highs, lows, closes, period = 14) {
  const tr = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) {
      tr[i] = highs[i] - lows[i];
    } else {
      tr[i] = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
    }
  }
  return wilderSmooth(tr, period);
}

export function obv(closes, volumes) {
  const out = new Array(closes.length).fill(null);
  let acc = 0;
  out[0] = 0;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) acc += volumes[i];
    else if (closes[i] < closes[i - 1]) acc -= volumes[i];
    out[i] = acc;
  }
  return out;
}

// ADX + directional indicators — measures trend strength (not direction alone)
export function adx(highs, lows, closes, period = 14) {
  const len = closes.length;
  const plusDM = new Array(len).fill(0);
  const minusDM = new Array(len).fill(0);
  const tr = new Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }
  const smTR = wilderSmooth(tr, period);
  const smPlus = wilderSmooth(plusDM, period);
  const smMinus = wilderSmooth(minusDM, period);
  const plusDI = new Array(len).fill(null);
  const minusDI = new Array(len).fill(null);
  const dx = new Array(len).fill(null);
  for (let i = 0; i < len; i++) {
    if (smTR[i] && smTR[i] !== 0) {
      plusDI[i] = (smPlus[i] / smTR[i]) * 100;
      minusDI[i] = (smMinus[i] / smTR[i]) * 100;
      const sum = plusDI[i] + minusDI[i];
      dx[i] = sum === 0 ? 0 : (Math.abs(plusDI[i] - minusDI[i]) / sum) * 100;
    }
  }
  const adxLine = wilderSmooth(dx, period);
  return { adx: adxLine, plusDI, minusDI };
}

// Convenience: last non-null value of an array
export function last(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

export function prev(arr) {
  let seen = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) {
      seen++;
      if (seen === 2) return arr[i];
    }
  }
  return null;
}
