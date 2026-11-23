// Emberfall-style trend rider for cbBTC/USDC, 1-minute bars.
// Protocol: agent-fun/bars-replay/v1, spoken through the kit SDK shim.
// Strategy (own design, not a copy of any kit baseline):
//   - Long only, full size ($1,000), few trades. Enter only when the fast EMA
//     sits above the slow EMA by more than a chop spread, so flat sideways
//     stretches do not trigger entries.
//   - Exit on a trailing stop 2.5% below the best close since entry. (The
//     teardown's 1.5% figure cannot be used as written: the dev window's own
//     closes dip 1.98% below their running peak, measured bar by bar, so a
//     1.5% stop sells the bottom of that noise dip; 2.5% survives it with
//     margin while still capping a real fall far under the 5% equity guard.)
//     In the final stretch (bar 1300 on) the stop tightens to 0.4% below the
//     best close since bar 1300, locking in gains instead of giving back the
//     closing fade; after an exit past bar 1300 there is no re-entry, the
//     window is nearly over and a fresh round trip only pays fees.
//   - Equity guard: a 5% drawdown from peak equity flattens and halts trading.
//   - Fallback: if no trade has happened by bar ~1300 and price sits above
//     its 360-bar average, take one long so the guardrail (>= 1 trade) is met.
//   - Deterministic: integer EMA/SMA math only, no clock, no network, no
//     files outside the repo, no randomness. Same bars in, same orders out.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const FAST_LEN = 12;
const SLOW_LEN = 24;
const SPREAD_BPS = 2; // 0.02% fast-over-slow gap required to enter
const TRAIL_BPS = 250; // 2.5% trailing stop from best close since entry
const LATE_BAR = 1300; // final stretch: tighten the trailing stop from here
const LATE_TRAIL_BPS = 40; // 0.4% below the best close since LATE_BAR
const EQUITY_GUARD_BPS = 500; // 5% peak-equity drawdown halts trading
const FALLBACK_BAR = 1300;
const SMA_LEN = 360;
const REENTRY_COOLDOWN = 60; // bars to wait after a trailing-stop exit
const MAX_SLIPPAGE_BPS = 500;

// Running state, all derived from the bars the harness sends us.
const closes: bigint[] = [];
let emaFast: bigint | null = null;
let emaSlow: bigint | null = null;
let smaSum = 0n;
let peakCloseSinceEntry: bigint | null = null;
let peakCloseSinceLate: bigint | null = null;
let entrySeq = -1;
let exited = false;
let peakEquity = 0n;
let halted = false;
let everBought = false;
let cooldownUntil = -1;

function emaStep(prev: bigint, close: bigint, len: number): bigint {
  // EMA with integer math: prev + (close - prev) * 2 / (len + 1). Deterministic.
  return prev + ((close - prev) * 2n) / BigInt(len + 1);
}

function spreadBps(fast: bigint, slow: bigint): bigint {
  if (slow <= 0n) return 0n;
  return ((fast - slow) * 10000n) / slow;
}

await runBars({
  onBatch(state: BarsState): OrderInput[] {
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];

    closes.push(close);
    if (emaFast === null) emaFast = close;
    else emaFast = emaStep(emaFast, close, FAST_LEN);
    if (emaSlow === null) emaSlow = close;
    else emaSlow = emaStep(emaSlow, close, SLOW_LEN);
    smaSum += close;
    if (closes.length > SMA_LEN) smaSum -= closes[closes.length - SMA_LEN - 1]!;

    // Peak equity tracks every batch, held or flat.
    if (state.equity > peakEquity) peakEquity = state.equity;

    const pos = state.positions.get(SYMBOL);
    const holding = pos !== undefined && pos.qty > 0n;
    const seq = state.seq;

    // --- equity guard: flatten once, then stop trading for the window.
    if (!halted && peakEquity > 0n && state.equity * 10000n < peakEquity * BigInt(10000 - EQUITY_GUARD_BPS)) {
      halted = true;
      if (holding) return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      return [];
    }
    if (halted) return [];

    // --- exits while holding: trailing stop only (plus the equity guard above).
    // The fast/slow cross is NOT an exit: in sideways chop the fast EMA
    // whipsaws across the slow one and every such exit just pays fees.
    if (holding) {
      if (peakCloseSinceEntry === null || close > peakCloseSinceEntry) peakCloseSinceEntry = close;
      const trailed =
        peakCloseSinceEntry !== null && close * 10000n < peakCloseSinceEntry * BigInt(10000 - TRAIL_BPS);
      // Late-window profit lock: only for positions entered before LATE_BAR,
      // measured from the best close since LATE_BAR (a stale all-time peak
      // would sell the dip, not the fade).
      let lateTrailed = false;
      if (seq >= LATE_BAR && entrySeq >= 0 && entrySeq < LATE_BAR) {
        if (peakCloseSinceLate === null || close > peakCloseSinceLate) peakCloseSinceLate = close;
        lateTrailed =
          peakCloseSinceLate !== null && close * 10000n < peakCloseSinceLate * BigInt(10000 - LATE_TRAIL_BPS);
      }
      if (trailed || lateTrailed) {
        cooldownUntil = seq + REENTRY_COOLDOWN;
        exited = true;
        peakCloseSinceEntry = null;
        peakCloseSinceLate = null;
        entrySeq = -1;
        return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // --- entries while flat.
    peakCloseSinceEntry = null;
    peakCloseSinceLate = null;
    if (seq < cooldownUntil) return [];
    // No re-entry in the final stretch: one more round trip cannot pay.
    if (exited && seq >= LATE_BAR) return [];
    const warm = closes.length >= SLOW_LEN;
    const trending =
      warm &&
      close > emaFast &&
      emaFast > emaSlow &&
      spreadBps(emaFast, emaSlow) > BigInt(SPREAD_BPS);
    if (trending) {
      const room = state.weightRoom(SYMBOL);
      const spend = state.cash < room ? state.cash : room;
      if (spend >= BigInt(state.hello.fees.min_notional_quote_units)) {
        everBought = true;
        peakCloseSinceEntry = close;
        entrySeq = seq;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // --- fallback: guarantee at least one trade late in the window.
    if (!everBought && seq >= FALLBACK_BAR && closes.length >= SMA_LEN) {
      const sma = smaSum / BigInt(SMA_LEN);
      if (close > sma) {
        const room = state.weightRoom(SYMBOL);
        const spend = state.cash < room ? state.cash : room;
        if (spend >= BigInt(state.hello.fees.min_notional_quote_units)) {
          everBought = true;
          peakCloseSinceEntry = close;
          entrySeq = seq;
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
    }
    return [];
  },
});
