# Breakout & Change-of-Structure Strategy

A mechanical, emotion-free trading strategy for SignalDesk: it takes **high-
conviction breakout and structure-shift setups** with **conservative, fixed-
fraction risk**. Every decision is numeric — there is nothing left to feel.

## Modules

| File | Role |
|------|------|
| `js/patterns.js` | Swing pivots, market structure (trend / **BOS** / **CHoCH**), and classical-pattern detectors: bull/bear flag, rising/falling wedge, cup & handle, head-&-shoulders / inverse. Each returns concrete **trigger / invalidation / target** levels + a 0–1 quality score. |
| `js/strategy.js` | `evaluate(candles, equity)` — runs every gate and returns either a risk-sized trade or a `NO_TRADE` with the reason it was filtered. |
| `js/backtest.js` | `backtest(candles)` — walk-forward simulator (no look-ahead), reports win rate, **expectancy in R**, profit factor, max drawdown. |
| `js/run-backtest.mjs` | Node runner + synthetic smoke test. |

## The gates (a trade fires only if ALL pass)

1. **Structure** — trend defined (HH/HL or LH/LL) or a fresh **CHoCH/BOS**.
2. **Pattern** — a flag / wedge / cup & handle / H&S is present.
3. **Breakout** — a *close* beyond the trigger, on volume ≥ 1.5× its 20-bar average.
4. **Retest** — (strict mode) price returned to the level and held.
5. **Risk gate** — structural stop gives reward:risk ≥ 2:1.

Then: **stop** = structural invalidation, **size** = `equity × 1% ÷ stop distance`
(so every trade risks the same $10 on a $1,000 book), **target** = measured move
or 2R.

## Run it

```bash
node js/run-backtest.mjs                # synthetic smoke test
node js/run-backtest.mjs candles.json   # your OHLCV data
```

`candles.json` is an array of `{time,open,high,low,close,volume}`. Produce it
from the Robinhood MCP `get_equity_historicals` tool **in your authenticated
local session** (this repo's remote session can't reach your account), dump it
to a file, and backtest it.

## Honest caveats — read before risking a dollar

- **This is not a proven edge.** The default parameters are literature-informed
  starting points, not validated winners. Classical patterns are fuzzy and
  hindsight-biased; the *only* way to know if they pay is to backtest **your**
  instruments and then paper-trade forward.
- **Backtest first, paper second, tiny live third.** Do not skip steps.
- **An LLM does not predict markets.** The agent executes these rules reliably;
  the edge (if any) comes from the rules, not from intuition.
- **Sizing is the safety.** 1% risk on $1,000 = $10 per trade. Keep it there
  until a real forward-tested track record justifies otherwise.
