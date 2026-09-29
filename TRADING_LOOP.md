# Live Trading Loop — Runbook

How the breakout / structure strategy runs against a **real Robinhood account**.

## Where it runs (important)

The strategy code lives in this repo, but the loop must run in a session **where
the Robinhood MCP connector is authenticated** — your own Claude Code / claude.ai
session, not the remote cloud session that built this. The remote build session
cannot see your account (its connector is unauthenticated by design). Think of it
as: *build & backtest here, run live there.*

## Timeframes (your workflow)

- **Entry** = 1h or 3h candles — where the breakout/pattern must confirm.
- **Daily** = primary trend filter — a signal against the daily trend is dropped.
- **Weekly** = conviction filter — agreement upgrades confidence; strict mode
  requires it.

`evaluateMTF()` enforces all three.

## What the agent does each cycle (in the authenticated session)

The loop is dependency-injected (`js/live-loop.mjs`): you give it a `fetchCandles`,
`getEquity`, and `execute` function, and it does the rest. Wired to Robinhood, one
cycle is:

1. **Account value** → `get_portfolio` / `get_accounts` → `getEquity()`.
2. **Roll the day** → `guard.rollDay(state, equity)` (resets daily counters).
3. **Manage open positions** — for each, `get_equity_historicals` (entry TF), check
   stop/target. If hit, in `execute` mode: `place_equity_order` to close.
4. **Scan the watchlist** — for each symbol, pull entry + daily + weekly candles
   via `get_equity_historicals`, run `evaluateMTF`, then `guard.canTrade`.
5. **Propose or place** — in `propose` mode (default), collect intended orders for
   your approval. In `execute` mode: `review_equity_order` → `place_equity_order`.

**Always run `propose` mode until a forward-tested track record exists.**

## The loss cap & guards (`js/risk-guard.js`)

Hard circuit breakers checked before every order — no override:

| Guard | Default | Effect |
|-------|---------|--------|
| Daily loss cap | −3% of start-of-day equity | Stop trading for the day |
| Max drawdown | −15% from peak | Auto-halt (kill switch) |
| Equity floor | 50% of start | Refuse to trade below it |
| Max concurrent | 3 positions | No new entries past it |
| Max trades/day | 5 | Overtrading guard |
| Max notional | 34% of book | No oversized single position |
| Per-trade risk | 1% ($10 on $1,000) | Sets position size |
| Kill switch | manual/auto | Blocks all trading until cleared |

State (`newState`) persists between cycles — save it to a JSON file (or a
Robinhood watchlist note) so the daily counters and open positions survive
restarts.

## Running it on a schedule

Two ways to make it a real "bot":

1. **On-demand, human-in-the-loop (recommended first):** in your authenticated
   session, ask the agent to "run one trading cycle" — it fetches, evaluates, and
   proposes; you approve each order. Safe, and you learn what it's seeing.
2. **Scheduled:** a recurring trigger (e.g. hourly during market hours) fires a
   session that runs `runCycle`. This only works if that session can reach
   Robinhood — i.e. the connector is available to scheduled runs. Keep it in
   `propose` mode (delivering proposals to you) until you trust it, then narrow to
   `execute` with the guards above.

## Promotion path — do not skip

1. **Backtest** (`node js/run-backtest.mjs candles.json`) — positive expectancy in R?
2. **Paper / propose** forward for weeks — do the live proposals match the backtest?
3. **Tiny live** at 1% risk, `execute` mode, guards on.
4. Re-evaluate. Only then consider loosening anything.
