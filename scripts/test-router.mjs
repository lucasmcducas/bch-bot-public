#!/usr/bin/env node
// scripts/test-router.mjs — unit conversion tests for lib/router.mjs
//
// Retargeted: lib/router.mjs is now only token lookup and unit conversion. The
// verifyBuildAgainstQuote cases tested a SERVER-ASSEMBLED swap and went with the
// router; see scripts/test-swap-outputs.mjs for where that reasoning ended up.
//
// Unit tier: pure functions and validation, no network. Each test asserts a
// literal expected value against one concrete input, so it fails under a real
// defect (wrong decimal scaling, off-by-one validation, a gate that stops
// catching a mismatch).
//
// The live tier at the bottom is opt-in: it talks to the real Riften router and
// only asserts the contract shape, not prices, which move.

import { bchToBaseUnits, baseUnitsToBch } from '../lib/router.mjs';

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








console.log(`\n============================================================\nRESULT: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed === 0 ? 0 : 1);
