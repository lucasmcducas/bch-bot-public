// scripts/test-sweep-selection.mjs
//
// Sweep is a dust consolidation, and it must never destroy a CashToken.
// selectSweepCandidates used to return token-bearing UTXOs whose sat value was
// under 2000, with the comment "Sweep if user opts in (always sweep for now)".
// Spending such a UTXO consumes the token with it, and the single change output
// does not preserve it -- so the token was simply gone.
//
// The rule is small but destructive, so it is pinned here: a token-bearing UTXO
// is excluded at EVERY value, including the smallest and the largest.

import { readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;
function eq(a, b, m = '') { if (a !== b) { failed++; console.error(`  ✗ ${m}expected ${b}, got ${a}`); return; } passed++; }
function ok(v, m) { if (!v) { failed++; console.error(`  ✗ ${m}`); return; } passed++; }

// The function is not exported (sweep.mjs is a script that runs on import), so
// exercise the source directly: extract the function body and evaluate it with
// the constant it depends on. If the shape of the source changes, this fails
// loudly rather than silently testing nothing.
const src = readFileSync(new URL('./sweep.mjs', import.meta.url), 'utf8');
const thresholdMatch = src.match(/const SWEEP_THRESHOLD_SATS\s*=\s*(\d+)n/);
ok(!!thresholdMatch, 'could not find SWEEP_THRESHOLD_SATS in sweep.mjs');
const SWEEP_THRESHOLD_SATS = BigInt(thresholdMatch[1]);

const bodyMatch = src.match(/function selectSweepCandidates\(utxos\)\s*\{([\s\S]*?)\n\}/);
ok(!!bodyMatch, 'could not find selectSweepCandidates in sweep.mjs');
// eslint-disable-next-line no-new-func
const selectSweepCandidates = new Function(
  'SWEEP_THRESHOLD_SATS',
  `return function selectSweepCandidates(utxos) {${bodyMatch[1]}\n}`
)(SWEEP_THRESHOLD_SATS);
const sweep = (utxos) => selectSweepCandidates(utxos);

const bch = (value) => ({ value: String(value), txid: 'a'.repeat(64), vout: 0 });
const token = (value) => ({ ...bch(value), token_data: { token: { category: 'c'.repeat(64) }, amount: '1000' } });

console.log('--- a token-bearing UTXO is never swept, at any value ---');
for (const value of [0n, 1n, 546n, 1999n, 2000n, 2001n, 5000n, 100000n, 100000000n]) {
  const r = sweep([token(value)]);
  // The only thing that matters at every value: it is never a candidate.
  eq(r.candidates.length, 0, `token UTXO of ${value} sats must not be a candidate: `);
  // A token UTXO below the threshold is deliberately held back and reported,
  // so the user learns the wallet has one. Above the threshold it is not
  // interesting at all -- the threshold already excluded it, so it is neither
  // a candidate nor a skip worth reporting.
  if (value < SWEEP_THRESHOLD_SATS) {
    eq(r.skippedTokens.length, 1, `token UTXO of ${value} sats (below threshold) must be reported: `);
  } else {
    eq(r.skippedTokens.length, 0, `token UTXO of ${value} sats is above threshold, not a special skip: `);
  }
}

console.log('--- a token UTXO and a BCH UTXO together: only the BCH one is swept ---');
{
  const r = sweep([token(1500n), bch(1500n)]);
  eq(r.candidates.length, 1, 'only the BCH UTXO is a candidate: ');
  ok(!('token_data' in r.candidates[0]), 'the candidate must be token-free: ');
  eq(r.skippedTokens.length, 1, 'the token UTXO is reported: ');
}

console.log('--- BCH-only dust is still swept (the feature still works) ---');
{
  const r = sweep([bch(100n), bch(546n), bch(1000n)]);
  eq(r.candidates.length, 3, 'all BCH dust is a candidate: ');
  eq(r.skippedTokens.length, 0, 'nothing was skipped: ');
}

console.log('--- BCH above the threshold is left alone ---');
{
  const r = sweep([bch(SWEEP_THRESHOLD_SATS), bch(SWEEP_THRESHOLD_SATS + 1n)]);
  eq(r.candidates.length, 0, 'a UTXO at the threshold is not swept: ');
}

console.log('--- an empty or absent token_data field is still BCH ---');
{
  // electrum servers vary in whether they send token_data as null vs absent.
  const r = sweep([{ ...bch(500n), token_data: null }, bch(500n)]);
  eq(r.candidates.length, 2, 'null token_data is not a token: ');
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
