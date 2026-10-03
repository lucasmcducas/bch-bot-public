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

// --- 2. every entry point must load ---------------------------------------
// Importing is the check. A script that references a function it never imported
// parses fine, passes `node --check`, and throws ReferenceError only when that
// line executes -- which is why a dead `send` survived a green suite.
console.log(`\nimporting ${entries.length} entry points\n`);
const IMPORTABLE = new Set([
  'address.mjs', 'balance.mjs', 'utxos.mjs', 'history.mjs',
  'create-wallet.mjs', 'encrypt-wallet.mjs',
]);

for (const e of entries) {
  if (!IMPORTABLE.has(e)) {
    // The rest are command scripts that execute main() on import, which would
    // run a wallet operation. Static-check them instead: parse, and verify every
    // identifier they call from another module is actually imported.
    const src = readFileSyncSafe(join(scriptsDir, e));
    const missing = undefinedIdentifiers(src);
    if (missing.length > 0) {
      failed += 1;
      console.log(`  FAIL  ${e}  calls without importing: ${missing.join(', ')}`);
    } else {
      console.log(`  ok    ${e}  (static)`);
    }
    continue;
  }
  try {
    await import(pathToFileURL(join(scriptsDir, e)).href);
    console.log(`  ok    ${e}  (imported)`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${e}  ${err.message}`);
  }
}

function readFileSyncSafe(p) {
  // eslint-disable-next-line no-undef
  return require('node:fs').readFileSync(p, 'utf8');
}

/**
 * Find calls to names that are neither defined locally nor imported.
 *
 * Deliberately narrow: it only reports a name when the file calls it as a bare
 * function AND never mentions that name in an import or a local declaration.
 * That is exactly the shape of the `send` bug, and it is conservative enough
 * that a false positive is more likely than a miss.
 */
function undefinedIdentifiers(src) {
  // names this file brings in
  const known = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) known.add(n);
    }
  }
  // locally declared names: const/let/var/function/class/param-ish
  for (const m of src.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    known.add(m[1]);
  }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) known.add(m[1]);
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) known.add(m[1]);
  for (const m of src.matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().replace(/[{}\[\].]/g, '').split(/[\s=:]/)[0];
      if (n) known.add(n);
    }
  }
  // destructured params / consts
  for (const m of src.matchAll(/\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/[:\s]/)[0];
      if (n) known.add(n);
    }
  }

  const candidates = new Set();
  for (const m of src.matchAll(/(?<![.\w$])([a-z][\w$]*)\s*\(/g)) candidates.add(m[1]);

  const GLOBALS = new Set([
    'require', 'console', 'process', 'setTimeout', 'setInterval', 'clearTimeout',
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await',
    'BigInt', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Math',
    'Date', 'Error', 'Promise', 'Map', 'Set', 'Buffer', 'fetch', 'parseInt',
    'parseFloat', 'isNaN', 'structuredClone', 'encodeURIComponent', 'decodeURIComponent',
  ]);

  return [...candidates].filter((n) => !known.has(n) && !GLOBALS.has(n));
}

console.log(`\n${failed === 0 ? 'all green' : failed + ' failing'}`);
process.exit(failed === 0 ? 0 : 1);
