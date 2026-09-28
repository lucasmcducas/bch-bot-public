// lib/fee.mjs — per-transaction treasury fee calculator
//
// Implements the 0.5% per-tx treasury fee from the Omarchy monetization plan
// (syntheses/bch-bot-omarchy-monetization-plan.md, "User decision 2026-09-19: flat 0.5%").
//
// The fee is **one extra output in the transaction** that pays the treasury
// address. This is invisible to Omarchy Core (or any wallet that doesn't know
// about it) and visible to the user in the send confirmation.
//
// Configuration (precedence: env > config file > default):
//   BCH_TREASURY_ADDRESS — BCH address the fee pays to
//   BCH_TREASURY_BPS     — basis points (50 = 0.5%)
//   BCH_TREASURY_MIN_SATS — skip fee if computed value < this (default 10)
//
// When BCH_TREASURY_ADDRESS is unset OR BCH_TREASURY_BPS=0, the fee is **disabled**
// and the function returns null. Self-hosters and forks can disable cleanly.
//
// IMPORTANT: this module does NOT validate the treasury address. Callers
// should verify the address format (cashaddr) before relying on the result.

const DEFAULT_BPS = 50; // 0.5%
const DEFAULT_MIN_SATS = 10n;

function loadTreasuryConfig() {
  const env = process.env;
  const bpsRaw = env.BCH_TREASURY_BPS ?? String(DEFAULT_BPS);
  const minRaw = env.BCH_TREASURY_MIN_SATS ?? String(DEFAULT_MIN_SATS);

  const bps = Number.parseInt(bpsRaw, 10);
  const minSats = BigInt(minRaw);

  if (!Number.isFinite(bps) || bps < 0 || bps > 10000) {
    throw new Error(`BCH_TREASURY_BPS invalid: ${bpsRaw} (must be 0..10000)`);
  }
  if (minSats < 0n) {
    throw new Error(`BCH_TREASURY_MIN_SATS invalid: ${minRaw}`);
  }

  return {
    address: env.BCH_TREASURY_ADDRESS ?? '',
    bps,
    minSats,
  };
}

/**
 * Compute the treasury fee for a transfer of `transferAmountSats`.
 *
 * @param {bigint} transferAmountSats — the amount being sent to the recipient.
 *   The treasury fee is computed on this amount only — never on the change.
 * @returns {{ address: string, valueSatoshis: bigint, bps: number, skipped: boolean, reason?: string } | null}
 *   - Returns null when the fee is disabled (no address or bps=0).
 *   - Returns { skipped: true, ... } when the computed fee is below the dust
 *     minimum (avoids creating a non-economic output).
 *   - Otherwise returns { address, valueSatoshis, bps }.
 */
export function computeTreasuryFee(transferAmountSats) {
  const cfg = loadTreasuryConfig();

  // Disabled if no address or 0 bps.
  if (!cfg.address || cfg.address.trim() === '') {
    return null;
  }
  if (cfg.bps === 0) {
    return null;
  }

  // Floor division: rounds down. User-friendly.
  const fee = (BigInt(transferAmountSats) * BigInt(cfg.bps)) / 10000n;

  if (fee < cfg.minSats) {
    return {
      address: cfg.address,
      valueSatoshis: 0n,
      bps: cfg.bps,
      skipped: true,
      reason: `computed ${fee} sat < minimum ${cfg.minSats} sat`,
    };
  }

  // Safety: fee should never exceed the transfer amount. If it does, return
  // a skipped marker (the caller decides what to do — likely refuse the tx).
  if (fee > BigInt(transferAmountSats)) {
    return {
      address: cfg.address,
      valueSatoshis: 0n,
      bps: cfg.bps,
      skipped: true,
      reason: `fee ${fee} sat exceeds transfer ${transferAmountSats} sat`,
    };
  }

  return {
    address: cfg.address,
    valueSatoshis: fee,
    bps: cfg.bps,
    skipped: false,
  };
}

/**
 * Wrap a list of base outputs with an optional treasury fee output.
 * If the fee is disabled or skipped, the original list is returned unchanged.
 *
 * @param {Array} outputs — list of { address, valueSatoshis, token? } outputs
 * @param {bigint} transferAmountSats — the amount the user is sending (not including change)
 * @returns {{ outputs: Array, fee: object | null }}
 */
export function withTreasuryFee(outputs, transferAmountSats) {
  const fee = computeTreasuryFee(transferAmountSats);
  if (!fee || fee.skipped) {
    return { outputs, fee };
  }

  // Insert the treasury output at the END (not in the middle of any token outputs).
  // Tokens are output-order-dependent in CashTokens, so always append.
  const augmented = [
    ...outputs,
    { address: fee.address, valueSatoshis: fee.valueSatoshis },
  ];

  return { outputs: augmented, fee };
}

/**
 * Format a treasury fee for user-facing display.
 *
 * @param {object|null} fee — result from computeTreasuryFee
 * @returns {string} — one-line display, or empty string if disabled
 */
export function formatFeeLine(fee) {
  if (!fee) return '';
  if (fee.skipped) {
    return `treasury fee: SKIPPED (${fee.reason ?? 'below minimum'})`;
  }
  const pct = (fee.bps / 100).toFixed(2);
  return `treasury fee: ${fee.valueSatoshis.toString()} sat (${pct}%) -> ${fee.address}`;
}
