// backtest.js
// Walk-forward simulator for the breakout / structure strategy. Replays candles
// one bar at a time, only ever letting the strategy see the past, opens on the
// NEXT bar's open (no look-ahead), then manages the trade bar-by-bar — including
// the profit-protection layer (breakeven, ATR trail, scale-out) when enabled.
// Output is the honest scorecard: win rate, expectancy in R, profit factor,
// max drawdown, average hold.

import { evaluate } from "./strategy.js";
import { managePosition, checkScaleOut, riskPerShare } from "./trade-manager.js";

// opts (beyond strategy opts):
//   warmup, feePct, equity, oneAtATime
//   manage   — true (default) applies breakeven/trail/scale-out; false = fixed
//              stop+target (useful for an A/B comparison)
//   mgmt     — overrides for MGMT_DEFAULTS
export function backtest(candles, opts = {}) {
  const warmup = opts.warmup ?? 60;
  const feePct = opts.feePct ?? 0.001;
  const manage = opts.manage ?? true;
  let equity = opts.equity ?? 1000;
  const oneAtATime = opts.oneAtATime ?? true;

  const trades = [];
  let open = null;
  let peakEquity = equity;
  let maxDD = 0;

  for (let i = warmup; i < candles.length - 1; i++) {
    const bar = candles[i];
    const next = candles[i + 1];

    if (open) {
      const long = open.side === "LONG";
      const view = candles.slice(0, i + 1);

      // (a) partial scale-out (a limit fill at +Nr) — realize on part of the size
      if (manage) {
        const so = checkScaleOut(open, bar, opts.mgmt);
        if (so && so.shares > 0) {
          const gross = long ? (so.price - open.entry) * so.shares : (open.entry - so.price) * so.shares;
          const fees = (open.entry + so.price) * so.shares * feePct;
          equity += gross - fees;
          open.realizedPartial += gross - fees;
          open.shares -= so.shares;
          open.scaledOut = true;
          open.target = null; // let the remainder run on the trail
          peakEquity = Math.max(peakEquity, equity);
        }
      }

      // (b) exit the remainder on the stop as of the PRIOR bar (no look-ahead),
      //     or the fixed target if still set.
      const hitStop = long ? bar.low <= open.stop : bar.high >= open.stop;
      const hitTgt = open.target != null && (long ? bar.high >= open.target : bar.low <= open.target);
      let exit = null, outcome = null;
      if (hitStop) { exit = open.stop; outcome = open.beMoved ? "trail/BE stop" : "stop"; }
      else if (hitTgt) { exit = open.target; outcome = "target"; }
      if (exit != null) {
        const gross = long ? (exit - open.entry) * open.shares : (open.entry - exit) * open.shares;
        const fees = (open.entry + exit) * open.shares * feePct;
        const pnl = gross - fees + (open.realizedPartial || 0);
        equity += gross - fees;
        const rMultiple = pnl / (open.oneR || 1);
        trades.push({ side: open.side, setup: open.setup, entry: open.entry, exit, outcome,
          scaledOut: !!open.scaledOut, pnl: round(pnl), rMultiple: round(rMultiple),
          bars: i - open.entryIdx, exitIdx: i });
        peakEquity = Math.max(peakEquity, equity);
        maxDD = Math.max(maxDD, (peakEquity - equity) / peakEquity);
        open = null;
      } else if (manage) {
        // (c) ratchet the stop (breakeven + trail) for the NEXT bar
        managePosition(open, view, opts.mgmt);
      }
    }

    if (!open) {
      const view = candles.slice(0, i + 1);
      const sig = evaluate(view, equity, opts);
      if (sig.action === "BUY" || sig.action === "SELL_SHORT") {
        const side = sig.action === "BUY" ? "LONG" : "SHORT";
        const entry = round(next.open);
        const rps = Math.abs(entry - sig.stop);
        open = {
          side, entry, stop: sig.stop, initialStop: sig.stop, target: sig.target,
          shares: sig.shares, riskPerShare: rps, oneR: rps * sig.shares,
          realizedPartial: 0, beMoved: false, scaledOut: false,
          setup: sig.setup, entryIdx: i + 1, confidence: sig.confidence,
        };
      }
    }
  }

  return summarize(trades, opts.equity ?? 1000, equity, maxDD, manage);
}

function summarize(trades, startEq, endEq, maxDD, manage) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const rSum = trades.reduce((a, t) => a + t.rMultiple, 0);
  const n = trades.length;
  return {
    managed: manage,
    trades: n,
    winRate: n ? round((wins.length / n) * 100) : 0,
    expectancyR: n ? round(rSum / n) : 0,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : (grossWin > 0 ? Infinity : 0),
    avgWin: wins.length ? round(grossWin / wins.length) : 0,
    avgLoss: losses.length ? round(-grossLoss / losses.length) : 0,
    avgBarsHeld: n ? round(trades.reduce((a, t) => a + t.bars, 0) / n) : 0,
    maxDrawdownPct: round(maxDD * 100),
    startEquity: round(startEq),
    endEquity: round(endEq),
    returnPct: round(((endEq - startEq) / startEq) * 100),
    tradeLog: trades,
  };
}

function round(v) { return v == null ? null : Math.round(v * 100) / 100; }
