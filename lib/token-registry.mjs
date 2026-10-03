// lib/token-registry.mjs
//
// A wallet cannot render a token balance without knowing how many decimals the
// token uses. `bch-bot balance` reported raw base units, so a wallet holding
// 100 ROACH displayed as "100" -- which is both wrong and alarming, since 100
// base units at 2 decimals is 1 ROACH.
//
// The count is not derivable from the chain: CashTokens base units carry no
// decimal metadata. The convention across CashTokens is 2, and every major
// token (PUSD, ROACH) uses it, but it is a CONVENTION and must be overridable.
//
// Decimals are display-only. They never affect signing: an amount is always
// sent as base units, and every conversion in this file is for presentation.
// Do not use it to build a transaction.

/**
 * Known token metadata, keyed by CashToken category id (64 hex chars).
 *
 * `decimals` is the only field that changes how an amount is displayed, and
 * `symbol` is a label. Neither is consensus.
 */
const TOKENS = {
  // ParyonUSD — the Cauldron stability-pool token. 2 decimals (100.00 = 10000).
  '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544': { symbol: 'PUSD', decimals: 2, name: 'ParyonUSD' },
  // ROACH — 2 decimals.
  '892cef80a326f92583766abb85562f550fe6a6ff9a7d458067680c720135ff53': { symbol: 'ROACH', decimals: 2, name: 'Roach' },
  // NOTE: a BRAINROT entry used to sit here with a 64-hex id. It was invented --
  // a run of ascending digits, never read off the chain -- and a registry is
  // consulted to decide whether a token is KNOWN, so a fabricated id can make an
  // arbitrary token render with the wrong symbol and decimals. Unknown tokens
  // fall through to raw base units, which is honest. Add a real id here only
  // after reading it off a confirmed mainnet output.
};

// CashTokens' overwhelmingly common convention. An unknown token is ASSUMED to
// be 2 decimals rather than shown raw, because "10000" with no explanation is
// worse than "10000.00" if the guess is wrong -- and the display always carries
// the raw base-unit amount alongside, so a wrong guess is visible rather than
// silently misleading.
export const DEFAULT_DECIMALS = 2;

export function tokenMeta(categoryId) {
  if (typeof categoryId !== 'string') return { symbol: null, decimals: DEFAULT_DECIMALS, name: null, known: false };
  const key = categoryId.toLowerCase();
  const hit = TOKENS[key];
  if (hit) return { ...hit, known: true };
  return { symbol: null, decimals: DEFAULT_DECIMALS, name: null, known: false };
}

/**
 * Render base units as a human string, without ever losing precision.
 *
 * Done with strings rather than Number: a token supply can exceed 2^53, and
 * `10000 / 10**2` in floating point is 100 but `9007199254740993n / 100n` is not
 * exact. Splitting the digits is the only safe way.
 */
export function formatBaseUnits(amount, decimals) {
  const value = BigInt(amount);
  if (decimals === 0) return value.toString();
  const neg = value < 0n;
  const digits = (neg ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals);
  // Trailing zeros in the fraction are noise: 1.50 PUSD is 1.5.
  const trimmed = frac.replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${trimmed ? '.' + trimmed : ''}`;
}

/** Everything a UI needs to render one fungible-token balance. */
export function describeToken(categoryId, baseUnits) {
  const meta = tokenMeta(categoryId);
  return {
    category: categoryId,
    symbol: meta.symbol,
    name: meta.name,
    decimals: meta.decimals,
    known: meta.known,
    // Both are included on purpose. `amount` is what a signer uses and must
    // never be derived from the display string; `display` is what a human
    // reads. A UI that shows only one of them is either unreadable or imprecise.
    amount: baseUnits.toString(),
    display: formatBaseUnits(baseUnits, meta.decimals),
  };
}
