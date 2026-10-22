# Safety rails & engine review

This document covers the portfolio safety layer added on top of the breakout /
change-of-structure engine, plus the findings from reviewing that engine.

## How to run

```bash
npm test            # 41 unit tests (node --test)
npm run safety:demo # shows every rail firing, end-to-end, no broker
npm run loop:demo   # the full strategy stack in SAFE propose mode
```

## The rails (all enforced in code)

| Rail | Where | Behaviour |
|------|-------|-----------|
| **Paper / dry-run default-ON** | `live-loop.mjs` | `dryRun` is ON unless *explicitly* set `false`. While ON, `execute()` is never called — not even for exits. A new strategy is paper-only until a human turns it live. |
| **Human approval before any buy** | `live-loop.mjs` | Every `ENTER` (buy) requires `deps.approve(action)` to return truthy. No approver, a falsy answer, or an approver that throws ⇒ the buy stays a proposal (`AWAITING_APPROVAL`). Fails **closed**. Exits/scale-outs reduce risk and do not need approval. |
| **Daily max-loss kill switch (3%)** | `risk-guard.js` | `canTrade` returns a **hard** halt when the account is down ≥ 3% on the day (`startOfDayEquity → equity`, marked-to-market). The loop stops scanning for the rest of the day; it re-arms on the next day rollover. |
| **15% per-name cap** | `strategy.js` + `risk-guard.js` | Sizing is the *smaller* of the risk-based size and 15% of equity (`cappedByPct` flags when the cap bound). The guard re-checks `notional + value-already-held ≤ 15%` as a backstop. |
| **30% cash floor** | `risk-guard.js` | A buy that would drop spendable cash below 30% of equity is blocked (soft skip — a cheaper name may still fit). Enforced whenever the loop supplies `getCash()`. |
| **Append-only decision log** | `decision-log.mjs` | Every decision — proposed, placed, skipped, blocked — is appended (fs flag `a`) as JSONL (or CSV). No update/delete API exists, by design. Secret-like fields are redacted. |

Pre-existing guards kept: max-drawdown kill (15% from peak, now with intraday
peak ratcheting via `markEquity`), min-equity floor, max concurrent positions,
max trades/day, and no-pyramiding.

### Live execution adapter (`robinhood-exec.mjs`)

The only place an approved decision becomes a real order. The broker function is
**injected** (`placeEquityOrder`) — this module imports no MCP tool — and it has
three independent gates, any one of which stops the order:

1. `live === false` (**the default**): the broker is never called; `execute()`
   returns the order it *would* have sent, for inspection.
2. A BUY must arrive `approved === true` (the loop stamps this only after a human
   yes). An unapproved buy is refused here too, so an upstream wiring mistake
   still cannot place it.
3. Shorting is refused outright (cash-only account); it also refuses when `live`
   but no `accountNumber` is set.

So there are **two independent dry-run switches** — the loop's `dryRun` and the
adapter's `live` — plus the approval gate. `test/robinhood-exec.test.mjs` proves,
at both the adapter level and end-to-end through the loop, that the broker mock
is never called in dry-run or without approval, and is called exactly once on the
live + approved path.

### Hard vs soft halts
`canTrade` now tags each block `hard` (account-wide: kill switch, drawdown,
daily loss, equity floor, max concurrent / trades-per-day) or soft (this name
only: per-name cap, cash floor, pyramiding). The loop `break`s the scan on a
hard halt and `continue`s past a soft one — replacing the previous brittle
regex match on the reason string.

## Engine review — findings

Reviewed `patterns.js` (pivots / structure / BOS / CHoCH / classical patterns),
`strategy.js`, and `mtf.js`.

**Fixed**
- *Drawdown measured from a stale peak.* `peakEquity` only updated on day
  rollover, so an intraday pump-then-dump understated drawdown vs. the kill
  threshold. Added `markEquity()` (called each cycle) to ratchet the high-water
  mark. *(risk-guard.js)*
- *Brittle hard-halt detection.* The loop decided whether to stop scanning by
  regex-matching the guard's human-readable reason. Replaced with an explicit
  `hard` boolean. *(risk-guard.js / live-loop.mjs)*
- *No concentration or cash enforcement at sizing time.* Added the 15% cap into
  `evaluate()` sizing and the cash floor into the guard. *(strategy.js / risk-guard.js)*

**Documented (left as-is — behaviour-preserving, flagged for the author)**
- `strategy.evaluate`: the final `if (rr < o.minRR) return no(...)` is **dead
  code** — `rr` is reassigned to `o.minRR` one line above when the measured move
  is too small, so the reward:risk gate can never reject; it *projects* a minRR
  target instead. This appears intentional (the comment says "else project a
  minRR target"), so behaviour was left unchanged, but the dead branch is
  misleading.
- `patterns.structure`: trend is read from the last two pivot highs and last two
  pivot lows **independently**, not from the strictly-alternating swing sequence;
  an `H2`/`L2` pair that isn't actually adjacent in time can misclassify a noisy
  range as a trend. BOS/CHoCH compare `lastClose` to the most recent *confirmed*
  pivot (which lags by `right` bars), so in a strong trend BOS can read as
  near-continuous. Usable as a coarse filter; not a precise structure model.
- `patterns.cupAndHandle`: `leftRim` is simply `closes[0]` of the window (not a
  detected local high) and is compared against a `rightRim` taken from highs —
  mixing close vs. high and assuming the window starts at the rim. Rim symmetry
  can pass coincidentally.
- `patterns.headAndShoulders`: the returned `armed` flag is never consumed by
  the strategy (which recomputes the break), so it is effectively dead metadata.

None of the documented items are crashes or safety issues; they affect
signal *quality*, which is exactly what the dry-run default + human approval +
append-only log exist to contain while the edge is validated forward.
