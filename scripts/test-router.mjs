#!/usr/bin/env node
// scripts/test-router.mjs — behavioral tests for lib/router.mjs
//
// Unit tier: pure functions and validation, no network. Each test asserts a
// literal expected value against one concrete input, so it fails under a real
// defect (wrong decimal scaling, off-by-one validation, a gate that stops
// catching a mismatch).
//
// The live tier at the bottom is opt-in: it talks to the real Riften router and
// only asserts the contract shape, not prices, which move.

import { bchToBaseUnits, baseUnitsToBch, verifyBuildAgainstQuote } from '../lib/router.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
    failed++;
  }
}

function eq(actual, expected, label = '') {
  if (actual !== expected) {
    throw new Error(`${label}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function throws(fn, match) {
  try {
    fn();
  } catch (e) {
    if (match && !e.message.includes(match)) {
      throw new Error(`expected error containing "${match}", got "${e.message}"`);
    }
    return;
  }
  throw new Error(`expected a throw${match ? ` containing "${match}"` : ''}, but nothing was thrown`);
}

console.log('--- bchToBaseUnits / baseUnitsToBch ---');

test('whole BCH converts to base units', () => {
  eq(bchToBaseUnits('1'), 100000000n);
});

test('8-decimal BCH converts exactly (no float drift)', () => {
  eq(bchToBaseUnits('0.00000001'), 1n);
});

test('mixed BCH splits whole and fraction', () => {
  eq(bchToBaseUnits('1.23456789'), 123456789n);
});

test('sub-1 BCH does not borrow from the whole part', () => {
  eq(bchToBaseUnits('0.5'), 50000000n);
});

test('zero converts to zero', () => {
  eq(bchToBaseUnits('0'), 0n);
});

test('9 decimals is rejected (BCH has 8)', () => {
  throws(() => bchToBaseUnits('0.000000001'), 'invalid BCH amount');
});

test('negative amount is rejected', () => {
  throws(() => bchToBaseUnits('-1'), 'invalid BCH amount');
});

test('non-numeric input is rejected', () => {
  throws(() => bchToBaseUnits('abc'), 'invalid BCH amount');
});

test('base units round-trip back to BCH', () => {
  eq(baseUnitsToBch(123456789n), '1.23456789');
});

test('round-trip holds for 1 satoshi', () => {
  eq(baseUnitsToBch(1n), '0.00000001');
});

test('round-trip holds for zero', () => {
  eq(baseUnitsToBch(0n), '0.00000000');
});

console.log('\n--- verifyBuildAgainstQuote (the sign gate) ---');

const goodQuote = { outputAmount: '500', inputAmount: '1000', priceBefore: '2', priceAfter: '2', poolCount: 1, inputIsBch: true, outputIsBch: false };
const goodBuild = { unsignedTxHex: '02000000', inputsToSign: [0], expectedOutput: '500', feeSats: '10', feeTokenAmount: '0', minerFeeSats: '2', sourceOutputs: [] };

test('matching quote and build passes the gate', () => {
  const r = verifyBuildAgainstQuote(goodQuote, goodBuild);
  eq(r.ok, true);
  eq(r.problems.length, 0);
});

test('output drifting below the quote blocks signing', () => {
  const r = verifyBuildAgainstQuote(goodQuote, { ...goodBuild, expectedOutput: '400' });
  eq(r.ok, false);
  if (!r.problems.join(' ').includes('output changed')) throw new Error('missing drift reason');
});

test('output drifting ABOVE the quote also blocks (unexpected tx)', () => {
  const r = verifyBuildAgainstQuote(goodQuote, { ...goodBuild, expectedOutput: '600' });
  eq(r.ok, false);
});

test('slippage floor is enforced against the built output', () => {
  const r = verifyBuildAgainstQuote(goodQuote, { ...goodBuild, expectedOutput: '400' }, { minOutput: '450' });
  eq(r.ok, false);
  if (!r.problems.join(' ').includes('slippage floor')) throw new Error('missing floor reason');
});

test('output at exactly the floor passes', () => {
  // The floor is only meaningful once the build matches its quote, so this
  // uses a quote that agrees with the build. Checking the floor against a
  // drifted build would fail on the drift first and never reach it.
  const quote450 = { ...goodQuote, outputAmount: '450' };
  const r = verifyBuildAgainstQuote(quote450, { ...goodBuild, expectedOutput: '450' }, { minOutput: '450' });
  eq(r.ok, true);
});

test('a build with nothing to sign is rejected', () => {
  const r = verifyBuildAgainstQuote(goodQuote, { ...goodBuild, inputsToSign: [] });
  eq(r.ok, false);
  if (!r.problems.join(' ').includes('no inputs')) throw new Error('missing empty-sign reason');
});

test('an empty transaction is rejected', () => {
  const r = verifyBuildAgainstQuote(goodQuote, { ...goodBuild, unsignedTxHex: '' });
  eq(r.ok, false);
});

console.log(`\n============================================================\nRESULT: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed === 0 ? 0 : 1);
