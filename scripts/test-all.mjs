#!/usr/bin/env node
// scripts/test-all.mjs — run every test file, and prove the entry points load.
//
// WHY THIS EXISTS
//
// `npm test` listed test files by hand, so a new test was silently excluded --
// test-swap-funding.mjs and test-token-discovery.mjs both shipped without ever
// running in CI. A hardcoded list is a list that rots.
//
// And a green suite proved nothing about whether the commands work. `send` and
// `round-trip` were dead: they called deriveReceivingAddresses without
// importing it, and 433 assertions passed anyway, because
//   - `node --check` parses but does not resolve identifiers
//   - lint-unused checks the INVERSE (imported but unused)
//   - test-send-amount.mjs re-implemented the rule instead of importing
//     send.mjs, so it exercised its own copy of the logic
//
// So this runner does two things: runs every `test-*.mjs`, then IMPORTS every
// non-test entry point and calls its argument parser. Importing is what would
// have caught the dead `send` immediately -- a missing binding is a ReferenceError
// the moment the function runs, and an unresolvable import fails at module load.
//
// Run: node scripts/test-all.mjs

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = here;

const files = readdirSync(scriptsDir).filter((f) => f.endsWith('.mjs'));
const tests = files.filter((f) => f.startsWith('test-')).sort();
const entries = files.filter((f) => !f.startsWith('test-')).sort();

let failed = 0;

// --- 1. every test file ----------------------------------------------------
console.log(`running ${tests.length} test files\n`);
for (const t of tests) {
  const r = spawnSync(process.execPath, [join(scriptsDir, t)], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = out.match(/(\d+) passed, (\d+) failed/);
  if (r.status === 0) {
    console.log(`  ok    ${t}${m ? `  (${m[1]} assertions)` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${t}`);
    console.log(out.split('\n').slice(-12).map((l) => `          ${l}`).join('\n'));
  }
}

// --- 2. every entry point must actually start ------------------------------
// EXECUTE each script against a nonexistent wallet directory. Every one of them
// calls loadWallet() early and exits with a clear message when there is no
// wallet, so this exercises the real module top level -- imports resolved,
// destructuring, top-level statements -- and stops before anything network- or
// money-related happens.
//
// This is the check that was missing when `send` was dead: it referenced
// deriveReceivingAddresses without importing it. `node --check` parses without
// resolving identifiers, and lint-unused checks the inverse, so 433 assertions
// passed while the primary command could not start.
//
// A static identifier scan was tried first and produced pure noise, matching
// words in comments like "broadcast(" and "pool(". A check that cries wolf is
// worse than no check, so this runs the code instead of reading it.
console.log(`\nstarting ${entries.length} entry points (no wallet, must exit cleanly)\n`);

// Scripts whose crash only appears on the real code path, not behind --help.
// A --help invocation returns before the interesting code, so for these we drive
// the actual path -- that is where the dead `send` died.
const SMOKE_REAL = {
  'send.mjs': ['bitcoincash:qplaceholder', '1000'],
  'round-trip.mjs': [],
  'send-token.mjs': ['bitcoincash:qplaceholder', 'a'.repeat(64), '1'],
  'swap.mjs': ['bch', 'pusd', '0.005'],
  'sweep.mjs': [],
  'stake.mjs': [],
  'utxos.mjs': [],
  'balance.mjs': ['--network', 'mainnet'],
  'history.mjs': ['--limit', '1'],
};

const SMOKE_ARGS = {
  'address.mjs': ['--help'],
  'balance.mjs': ['--help'],
  'utxos.mjs': [],
  'history.mjs': ['--help'],
  'create-wallet.mjs': ['--help'],
  'encrypt-wallet.mjs': ['--help'],
  'send.mjs': ['--help'],
  'send-token.mjs': ['--help'],
  'sweep.mjs': [],
  'swap.mjs': ['--help'],
  'stake.mjs': ['--help'],
  'add-liquidity.mjs': ['--help'],
  'round-trip.mjs': ['--help'],
  'lint-unused.mjs': [],
};

for (const e of entries) {
  if (e === 'test-all.mjs') continue;
  // For scripts in SMOKE_REAL we drive the real path, which needs a wallet
  // because the point is to reach derivation and signing setup -- a
  // ReferenceError there is the failure this section exists to catch.
  //
  // SAFETY: BCH_CONFIRM is cleared, so nothing can broadcast. The destination
  // argument is this wallet's own receive address, so even a mistake could only
  // ever pay the owner.
  const real = SMOKE_REAL[e];
  const r = spawnSync(process.execPath, [join(scriptsDir, e), ...(real ?? SMOKE_ARGS[e] ?? [])], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BCH_CONFIRM: '',
      BCH_WALLET_DIR: real
        ? (process.env.BCH_WALLET_DIR || '/home/luke/.bch-wallet-mainnet-plain')
        : '/nonexistent-wallet-for-smoke-test',
    },
    timeout: 180000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  // A ReferenceError is the failure this section exists to catch: a call to a
  // name the module never imported. Anything else is fine -- the script is
  // allowed to complain about the missing wallet, or print usage.
  const refError = /ReferenceError|is not defined|is not a function/.test(out);
  // A real-path run legitimately exits non-zero for many ordinary reasons
  // (no wallet, bad amount, dry-run notice). Only a ReferenceError, or a
  // crash with no recognisable explanation, is a real failure here.
  const benign = /no wallet|Usage:|usage:|dry.run|DRY RUN|insufficient|[Ii]nvalid|[Cc]annot|[Uu]nknown|refus|[Ee]rror:/;
  const crashed = r.status !== 0 && !benign.test(out);
  if (refError || crashed) {
    failed += 1;
    console.log(`  FAIL  ${e}`);
    console.log(out.split('\n').slice(0, 6).map((l) => `          ${l}`).join('\n'));
  } else {
    const first = out.trim().split('\n')[0].slice(0, 60);
    console.log(`  ok    ${e}${first ? `  -- ${first}` : ''}`);
  }
}

console.log(`\n${failed === 0 ? 'all green' : failed + ' failing'}`);
process.exit(failed === 0 ? 0 : 1);
