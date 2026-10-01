// scripts/test-token-registry.mjs
//
// lib/token-registry.mjs exists because a wallet cannot render a token balance
// without knowing the decimals: `bch-bot balance` reported raw base units, so a
// wallet holding 100 ROACH displayed as "100". CashTokens base units carry no
// decimal metadata, so the wallet has to supply it.
//
// The formatting is done with strings, never Number, because a token supply can
// exceed 2^53 and floating point division is not exact there. That is asserted
// below rather than assumed.

import { formatBaseUnits, tokenMeta, describeToken, DEFAULT_DECIMALS } from '../lib/token-registry.mjs';

let passed = 0;
let failed = 0;
function eq(actual, expected, label) {
  if (actual === expected) { passed++; return; }
  failed++;
  console.error(`  ✗ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function ok(v, label) { if (v) { passed++; return; } failed++; console.error(`  ✗ ${label}`); }

const ROACH = '892cef80a326f92583766abb85562f550fe6a6ff9a7d458067680c720135ff53';
const PUSD = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
const UNKNOWN = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

console.log('--- base units to a human string ---');
{
  eq(formatBaseUnits(100n, 2), '1', '100 base units at 2 decimals is 1');
  eq(formatBaseUnits(10000n, 2), '100', '10000 at 2 decimals is 100');
  eq(formatBaseUnits(150n, 2), '1.5', 'trailing zeros are trimmed');
  eq(formatBaseUnits(100n, 2), '1', 'exactly one whole');
  eq(formatBaseUnits(1n, 2), '0.01', 'one base unit is 0.01');
  eq(formatBaseUnits(0n, 2), '0', 'zero');
  eq(formatBaseUnits(0n, 0), '0', 'zero with no decimals');
  eq(formatBaseUnits(42n, 0), '42', 'no decimals means no fraction');
  eq(formatBaseUnits(1n, 0), '1', 'one, no decimals');
  eq(formatBaseUnits(1010n, 3), '1.01', '3 decimals');
  eq(formatBaseUnits(5n, 8), '0.00000005', '8 decimals, the satoshi case');
  eq(formatBaseUnits(100000000n, 8), '1', '1 BCH in sats at 8 decimals');
}

console.log('--- it is exact where floating point is not ---');
{
  // 2^53 + 1 is the first integer a double cannot represent. If this were done
  // with Number, the answer would come back wrong.
  const huge = (2n ** 53n) + 1n;
  const shown = formatBaseUnits(huge, 0);
  eq(shown, huge.toString(), '2^53+1 survives at 0 decimals');
  // The same value at 2 decimals must not gain or lose a digit.
  eq(formatBaseUnits(huge, 2), `${huge / 100n}.${String(huge % 100n).padStart(2, '0')}`,
    '2^53+1 at 2 decimals is exact');
  // A very large supply does not become exponential notation, which is what
  // Number(huge).toString() would produce.
  const veryHuge = 123456789012345678901234567890n;
  ok(!formatBaseUnits(veryHuge, 2).includes('e'), 'no exponential notation');
  ok(formatBaseUnits(veryHuge, 2).startsWith('1234567890123456789012345678'), 'digits preserved exactly');
}

console.log('--- metadata lookup ---');
{
  const roach = tokenMeta(ROACH);
  eq(roach.symbol, 'ROACH', 'ROACH symbol: ');
  eq(roach.decimals, 2, 'ROACH decimals: ');
  ok(roach.known, 'ROACH is known');

  const pusd = tokenMeta(PUSD);
  eq(pusd.symbol, 'PUSD', 'PUSD symbol: ');

  // Case must not matter: category ids arrive from Electrum in lowercase, but
  // a hand-typed address or a pasted id may not be.
  eq(tokenMeta(ROACH.toUpperCase()).symbol, 'ROACH', 'lookup is case-insensitive');

  const unknown = tokenMeta(UNKNOWN);
  ok(!unknown.known, 'an unknown token is not claimed to be known');
  eq(unknown.symbol, null, 'an unknown token has no invented symbol');
  eq(unknown.decimals, DEFAULT_DECIMALS, `an unknown token assumes ${DEFAULT_DECIMALS} decimals`);
  eq(tokenMeta(undefined).known, false, 'undefined is not known');
  eq(tokenMeta(null).known, false, 'null is not known');
}

console.log('--- describeToken gives a UI everything it needs ---');
{
  const d = describeToken(ROACH, 100n);
  eq(d.display, '1', 'display: ');
  eq(d.amount, '100', 'amount stays in exact base units: ');
  eq(d.symbol, 'ROACH', 'symbol: ');
  eq(d.decimals, 2, 'decimals: ');
  eq(d.category, ROACH, 'category: ');

  // The display string must never be the thing a signer uses. Both are present
  // precisely so a caller cannot be forced to parse the display value back.
  eq(describeToken(ROACH, 100n).amount, '100', 'amount is base units, not "1"');
  eq(describeToken(UNKNOWN, 500n).display, '5', 'an unknown token still renders');
  eq(describeToken(UNKNOWN, 500n).known, false, 'and is flagged as unknown');
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
