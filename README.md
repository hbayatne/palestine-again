# ▲ SignalDesk — Trading Signal Engine

A transparent, multi-indicator **buy / sell / hold** signal tool that blends
**technical analysis** with **fundamentals**. It pulls real market data, computes
the same indicators professional traders use, and combines them into a single
weighted score — always showing *why*, never a black box.

> ⚠️ **Not financial advice. Read the honesty note at the bottom before using this.**

## What it does

- **Live market data** — pulls OHLCV candles from Binance's public API (no key needed).
  Falls back to a deterministic synthetic series if the network is blocked, so it always runs.
- **9 technical indicators**, each hand-implemented in `js/indicators.js`:
  SMA (20/50/200), EMA (12/26), RSI, MACD, Bollinger Bands, Stochastic, ATR, OBV, ADX.
- **Weighted signal engine** (`js/signals.js`) — every indicator casts a vote in
  `[-1, +1]` with a plain-English reason. Votes are combined by weight into a
  composite score in `[-100, +100]`, gated by ADX trend strength.
- **Confidence score** — measures how much the indicators *agree*, not just the raw score.
- **ATR-based trade plan** — suggested entry, stop-loss (1.5× ATR), and a 2:1
  reward-to-risk target, with position-sizing guidance.
- **Fundamentals layer** — for major crypto assets, scores market-cap rank,
  liquidity/turnover, distance from ATH, 30-day momentum and supply dilution
  (via CoinGecko), then blends it 70/30 with the technical score.
- **Candlestick chart** with SMA/Bollinger overlays and an RSI subpanel, drawn on
  a plain `<canvas>` — no chart libraries, no dependencies at all.

## Run it

It's a static site — no build step, no install.

```bash
# from the repo root
python3 -m http.server 8000
# then open http://localhost:8000
```

Or just open `index.html` directly in a modern browser (Chrome/Firefox/Safari).

> **Note on data:** Live prices come from `api.binance.com` and fundamentals from
> `api.coingecko.com`, called directly from your browser. Both support CORS, so
> they work from a normal browser. If a network/firewall blocks them, the app
> automatically switches to synthetic demo data (you'll see a note in the status
> bar) so every feature is still exercisable.

## How the signal is built

```
each indicator ──► vote in [-1,+1] + reason
                        │
             × weight × ADX multiplier (trend-followers only)
                        │
                        ▼
        composite score in [-100, +100]  ──►  action band
                        │                       ≥45  STRONG BUY
        confidence = agreement × strength       ≥18  BUY
                        │                       ±18  HOLD
        (+ optional 30% fundamentals blend)    ≤-18  SELL
                                               ≤-45  STRONG SELL
```

Trend-following signals (trend structure, MACD, EMA cross) are amplified when ADX
shows a strong trend and dampened when ADX shows a choppy range — because those
tools fail in sideways markets, while the oscillators (RSI, Stochastic, Bollinger)
are left alone since they work *better* in ranges.

## Project layout

| File | Responsibility |
|------|----------------|
| `index.html` | Layout & UI shell |
| `css/styles.css` | Dark trading-desk theme |
| `js/indicators.js` | Pure TA math (dependency-free) |
| `js/signals.js` | Voting + weighting → decision, confidence, trade plan |
| `js/data.js` | Live/synthetic data + fundamentals scoring |
| `js/app.js` | Wiring, rendering, canvas chart |

## Honest limitations — please read

This tool **cannot tell you "exactly" when to buy or sell**, and it does **not**
make "high-percentage" or guaranteed winning decisions. Anyone — or any app —
claiming that is wrong or lying.

- Technical indicators describe the *past*. They do not predict the future.
- Markets move on news, liquidity, and randomness that no chart can see coming.
- Every indicator here can and will be wrong, sometimes badly, and combining them
  reduces noise but does not remove risk.
- Backtested or "optimal" settings routinely fail on live data (overfitting).

Use this as a **decision-support and learning tool**, not an oracle. Always use a
stop-loss, never risk more than 1–2% of your account on a single trade, and never
trade money you can't afford to lose. Do your own research.
