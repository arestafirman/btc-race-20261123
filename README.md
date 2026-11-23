[![make.fun](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/c/btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/arestafirman/btc-race-20261123/rank.svg)](https://make.fun/c/btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/arestafirman/btc-race-20261123/reward.svg)](https://make.fun/c/btc-race-24h-20261123-0511)

# btc-race-20261123 — Trend Rider for cbBTC/USDC

A trading bot for the Make.fun competition
[btc-race-24h-20261123-0511](https://make.fun/c/btc-race-24h-20261123-0511):
race a BTC trading bot live for 24 hours on 1-minute cbBTC/USDC bars, starting
with $1,000 USDC of paper money, long only.

## Strategy

Trend rider + chop filter, long only, full size, few trades:

- **Enter** only when close > fast EMA (12) > slow EMA (24) and the fast/slow
  spread exceeds 0.02% — the spread threshold is the chop filter, so flat
  sideways stretches do not trigger entries.
- **Exit** on a trailing stop 2.5% below the best close since entry. The
  fast/slow cross is deliberately not an exit: in sideways chop it whipsaws
  and every exit just pays fees. Note: the teardown's 1.5% figure was
  measured against the dev window and cannot stand — closes dip 1.98% below
  their running peak, so a 1.5% stop sells the bottom of that noise dip.
  From bar 1300 the stop tightens to 0.4% below the best close since bar
  1300 (profit lock on the closing fade), and after an exit past bar 1300
  there is no re-entry. After a trailing-stop exit the bot waits 60 bars
  before re-entering.
- **Equity guard:** a 5% drawdown from peak equity flattens the position and
  halts trading for the rest of the window (far under the 25% cap).
- **Fallback:** if no trade has happened by bar ~1300 and price sits above
  its 360-bar average, take one long so the ≥1 trade guardrail is met.

Deterministic: integer EMA/SMA math only, no network, no wall clock, no
files outside the repo, no randomness. Same bars in, same orders out.

## Dev window (local grade)

| bot | dev net PnL | trades |
| --- | --- | --- |
| momentum baseline | +$34.94 | 1 |
| buy-and-hold baseline | +$32.17 | 1 |
| this bot | +$37.32 | 2 | grade-local, driver process, L1 regrade byte-identical |

Grade locally with the official kit:

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## Layout

- `main.ts` — the bot (Node 22, TypeScript, stdlib only + kit SDK shim).
- `vendor/makefun-bars.ts` — kit SDK shim, byte-identical, untouched.
- `.makefun/owner.json` — claim file for the entry wallet.
- `LICENSE` — MIT.
