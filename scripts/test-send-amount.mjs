// scripts/test-send-amount.mjs
//
// The send path's amount contract. `bch-bot send <addr> <amount>` accepts a
// bare integer of satoshis OR a BCH amount with a decimal point, and the
// plugin's panel labels its field "Amount (BCH)" -- so the two must agree, or
// the primary send flow in the shipped alpha is unusable (typing what the UI
// says used to throw "Cannot convert 0.001 to a BigInt", and the natural
// "fix" of typing 1000 sent 1000 sats = 0.00001 BCH, a hundred times less
// than intended).
//
// This asserts the conversion the script uses. It cannot call send.mjs's main()
// directly without a wallet and a network, so the rule is pinned here at the
// same seam the script uses: bchToBaseUnits from lib/router.mjs, with the
// script's own branch that decides which form was supplied.

import { bchToBaseUnits, baseUnitsToBch } from '../lib/router.mjs';

let passed = 0;
let failed = 0;

function assertEq(actual, expected, label) {
  if (actual === expected) { passed++; return; }
  failed++;
  console.error(`  ✗ ${label}: expected ${expected}, got ${actual}`);
}

function assertThrows(fn, label) {
  try { fn(); } catch { passed++; return; }
  failed++;
  console.error(`  ✗ ${label}: expected a throw, got none`);
}

// The exact rule scripts/send.mjs applies to the amount argument. Kept in step
// with the script on purpose: this is the only place the contract is pinned, and
// a test that reimplements the rule loosely would not catch the rule regressing.
function parseAmount(amountArg) {
  if (/^\d+\.\d*$/.test(amountArg)) return bchToBaseUnits(amountArg);
  if (/^\d+$/.test(amountArg)) return BigInt(amountArg);
  throw new Error('unrecognised amount form');
}

console.log('--- a decimal point means BCH ---');
assertEq(parseAmount('0.001'), 100000n, '0.001 BCH is 100000 sats');
assertEq(parseAmount('1.0'), 100000000n, '1.0 BCH is 1e8 sats');
assertEq(parseAmount('2.5'), 250000000n, '2.5 BCH is 2.5e8 sats');
assertEq(parseAmount('0.00000001'), 1n, 'one satoshi expressed in BCH');

console.log('--- a bare integer means satoshis ---');
assertEq(parseAmount('1000'), 1000n, '1000 is 1000 sats, not 0.00001 BCH reinterpreted');
assertEq(parseAmount('1'), 1n, '1 is one satoshi, not 1 BCH');
assertEq(parseAmount('2100000000000000'), 2100000000000000n, 'max supply is unchanged');

console.log('--- round trip ---');
// baseUnitsToBch always emits 8 decimals, which is the canonical form and the
// one a user should see. Compare against that, not against the input spelling.
const canonical = (bch) => {
  const [whole, frac = ''] = bch.split('.');
  return `${whole}.${frac.padEnd(8, '0')}`;
};
for (const bch of ['0.001', '1', '2.5', '0.00000001', '123.45678901']) {
  assertEq(baseUnitsToBch(bchToBaseUnits(bch)), canonical(bch), `round trip ${bch}`);
}

console.log('--- rejections ---');
// 9 decimal places is below one satoshi and must not be silently truncated.
assertThrows(() => parseAmount('1.123456789'), '9 decimal places throws');
assertThrows(() => parseAmount('0.000000001'), 'a billionth of a satoshi throws');
assertThrows(() => parseAmount('abc'), 'non-numeric throws');
assertThrows(() => parseAmount('.5'), 'leading-dot throws (no whole part)');
assertThrows(() => parseAmount('1e3'), 'exponent notation throws');
assertThrows(() => parseAmount('0x10'), 'hex throws');

// The values the plugin's panel can actually produce.
assertEq(parseAmount('0.001') > 0n, true, 'the panel placeholder 0.001 is a sendable amount');
assertEq(parseAmount('0.00000001') > 0n, true, 'one satoshi is sendable, not rounded to zero');

console.log(`\nRESULT: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
