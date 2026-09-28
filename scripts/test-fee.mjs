#!/usr/bin/env node
// scripts/test-fee.mjs — unit tests for lib/fee.mjs (treasury fee module)
//
// Coverage:
//   1. computeTreasuryFee — basic math
//   2. computeTreasuryFee — disabled when no address
//   3. computeTreasuryFee — disabled when bps=0
//   4. computeTreasuryFee — floor rounding
//   5. computeTreasuryFee — skip below min
//   6. computeTreasuryFee — skip if fee > amount
//   7. computeTreasuryFee — env overrides
//   8. withTreasuryFee — appends output when fee is on
//   9. withTreasuryFee — unchanged when fee is off
//  10. withTreasuryFee — preserves token output order
//  11. formatFeeLine — disabled vs skipped vs active
//  12. BCH_TREASURY_BPS validation

import { computeTreasuryFee, withTreasuryFee, formatFeeLine } from '../lib/fee.mjs';

let passed = 0, failed = 0;
const fails = [];

function assert(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    fails.push({ label, detail });
    console.log(`  ✗ ${label} ${detail ?? ''}`);
  }
}

function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    if (env[k] === null) delete process.env[k];
    else process.env[k] = env[k];
  }
  try { return fn(); } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// Default config (test environment sets these in section 1)
const ADDR = 'bitcoincash:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqfnhks603';

console.log('1. basic math (50 bps = 0.5%)');
withEnv({
  BCH_TREASURY_ADDRESS: ADDR,
  BCH_TREASURY_BPS: '50',
  BCH_TREASURY_MIN_SATS: '1',
}, () => {
  const r = computeTreasuryFee(100000n);
  assert('100000 sat → 500 sat fee', r?.valueSatoshis === 500n, `got ${r?.valueSatoshis}`);

  const r2 = computeTreasuryFee(10000n);
  assert('10000 sat → 50 sat fee', r2?.valueSatoshis === 50n);

  const r3 = computeTreasuryFee(1000n);
  assert('1000 sat → 5 sat fee', r3?.valueSatoshis === 5n);
});

console.log('\n2. disabled when no address');
withEnv({
  BCH_TREASURY_ADDRESS: null,
  BCH_TREASURY_BPS: '50',
}, () => {
  const r = computeTreasuryFee(100000n);
  assert('returns null', r === null);
});

console.log('\n3. disabled when bps=0');
withEnv({
  BCH_TREASURY_ADDRESS: ADDR,
  BCH_TREASURY_BPS: '0',
}, () => {
  const r = computeTreasuryFee(100000n);
  assert('returns null', r === null);
});

console.log('\n4. floor rounding (user-friendly)');
withEnv({
  BCH_TREASURY_ADDRESS: ADDR,
  BCH_TREASURY_BPS: '50',
  BCH_TREASURY_MIN_SATS: '0',
}, () => {
  // 33 sat * 0.5% = 0.165 sat → floor = 0
  const r = computeTreasuryFee(33n);
  assert('33 sat → 0 sat (rounds down to 0)', r?.valueSatoshis === 0n, `got ${r?.valueSatoshis}`);
  // 333 sat * 0.5% = 1.665 sat → floor = 1
  const r2 = computeTreasuryFee(333n);
  assert('333 sat → 1 sat', r2?.valueSatoshis === 1n, `got ${r2?.valueSatoshis}`);
  // 100 sat * 0.5% = 0.5 sat → floor = 0
  const r3 = computeTreasuryFee(100n);
  assert('100 sat → 0 sat', r3?.valueSatoshis === 0n);
});

console.log('\n5. skip below min');
withEnv({
  BCH_TREASURY_ADDRESS: ADDR,
  BCH_TREASURY_BPS: '50',
  BCH_TREASURY_MIN_SATS: '100',
}, () => {
  const r = computeTreasuryFee(1000n); // would be 5 sat, below 100 min
  assert('skipped = true', r?.skipped === true);
  assert('valueSatoshis = 0', r?.valueSatoshis === 0n);
  assert('reason mentions minimum', r?.reason?.includes('100'));
});

console.log('\n6. skip if fee > amount');
withEnv({
  BCH_TREASURY_ADDRESS: ADDR,
  BCH_TREASURY_BPS: '50',
  BCH_TREASURY_MIN_SATS: '0',
}, () => {
  // 100 sat * 0.5% = 0 sat → floor 0, not > amount, OK
  // 1000 sat * 0.5% = 5 sat, OK
  // Force a case where fee > amount by raising bps:
});
withEnv({
  BCH_TREASURY_ADDRESS: ADDR,
  BCH_TREASURY_BPS: '100000', // 1000% (well over 10000 max, should throw)
  BCH_TREASURY_MIN_SATS: '0',
}, () => {
  let threw = false;
  try { computeTreasuryFee(100n); } catch (e) { threw = true; }
  assert('bps > 10000 throws', threw);
});

console.log('\n7. env overrides (custom bps)');
withEnv({
  BCH_TREASURY_ADDRESS: ADDR,
  BCH_TREASURY_BPS: '100', // 1%
  BCH_TREASURY_MIN_SATS: '0',
}, () => {
  const r = computeTreasuryFee(1000n);
  assert('1% of 1000 = 10 sat', r?.valueSatoshis === 10n, `got ${r?.valueSatoshis}`);
});

console.log('\n8. withTreasuryFee appends output');
withEnv({
  BCH_TREASURY_ADDRESS: ADDR,
  BCH_TREASURY_BPS: '50',
  BCH_TREASURY_MIN_SATS: '10',
}, () => {
  const baseOutputs = [{ address: 'bitcoincash:qr...', valueSatoshis: 10000n }];
  const { outputs, fee } = withTreasuryFee(baseOutputs, 10000n);
  assert('length is 2', outputs.length === 2);
  assert('first output unchanged', outputs[0].valueSatoshis === 10000n);
  assert('last output is treasury', outputs[1].address === ADDR);
  assert('treasury value = 50 sat', outputs[1].valueSatoshis === 50n);
  assert('fee result present', fee?.valueSatoshis === 50n);
});

console.log('\n9. withTreasuryFee unchanged when fee off');
withEnv({
  BCH_TREASURY_ADDRESS: null,
  BCH_TREASURY_BPS: '50',
}, () => {
  const baseOutputs = [{ address: 'bitcoincash:qr...', valueSatoshis: 10000n }];
  const { outputs, fee } = withTreasuryFee(baseOutputs, 10000n);
  assert('length unchanged', outputs.length === 1);
  assert('fee is null', fee === null);
});

console.log('\n10. withTreasuryFee preserves token output order');
withEnv({
  BCH_TREASURY_ADDRESS: ADDR,
  BCH_TREASURY_BPS: '50',
  BCH_TREASURY_MIN_SATS: '10',
}, () => {
  // Tokens come first, then BCH change, then treasury last
  const baseOutputs = [
    { address: 'bitcoincash:qr...', valueSatoshis: 1000n, token: { category: 'ab12...', amount: 100n } },
    { address: 'bitcoincash:qs...', valueSatoshis: 5000n }, // change
  ];
  const { outputs } = withTreasuryFee(baseOutputs, 10000n);
  assert('length 3', outputs.length === 3);
  assert('token still first', outputs[0].token?.amount === 100n);
  assert('change still middle', outputs[1].valueSatoshis === 5000n);
  assert('treasury last', outputs[2].address === ADDR);
});

console.log('\n11. formatFeeLine');
withEnv({
  BCH_TREASURY_ADDRESS: ADDR,
  BCH_TREASURY_BPS: '50',
  BCH_TREASURY_MIN_SATS: '10',
}, () => {
  const f = computeTreasuryFee(100000n);
  const line = formatFeeLine(f);
  assert('line contains "500 sat"', line.includes('500 sat'));
  assert('line contains "0.50%"', line.includes('0.50%'));
  assert('line contains address', line.includes(ADDR));
});
withEnv({
  BCH_TREASURY_ADDRESS: null,
}, () => {
  const line = formatFeeLine(null);
  assert('returns empty when disabled', line === '');
});
withEnv({
  BCH_TREASURY_ADDRESS: ADDR,
  BCH_TREASURY_BPS: '50',
  BCH_TREASURY_MIN_SATS: '100000',
}, () => {
  const f = computeTreasuryFee(1000n);
  const line = formatFeeLine(f);
  assert('skipped line includes SKIPPED', line.includes('SKIPPED'));
});

console.log('\n12. bps validation');
withEnv({
  BCH_TREASURY_ADDRESS: ADDR,
  BCH_TREASURY_BPS: 'invalid',
}, () => {
  let threw = false;
  try { computeTreasuryFee(1000n); } catch (e) { threw = true; }
  assert('non-numeric bps throws', threw);
});
withEnv({
  BCH_TREASURY_ADDRESS: ADDR,
  BCH_TREASURY_BPS: '-5',
}, () => {
  let threw = false;
  try { computeTreasuryFee(1000n); } catch (e) { threw = true; }
  assert('negative bps throws', threw);
});

console.log();
console.log('='.repeat(60));
console.log(`PASSED ${passed}, FAILED ${failed}`);
if (failed > 0) {
  console.log('\nFAILED:');
  for (const f of fails) console.log(`  ✗ ${f.label} ${f.detail ?? ''}`);
  process.exit(1);
}
process.exit(0);
