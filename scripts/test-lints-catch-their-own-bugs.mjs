// scripts/test-lints-catch-their-own-bugs.mjs
//
// A lint that has only ever run against correct code is not a lint, it is
// decoration. Each of the two lints added on 2026-10-03 encodes a specific
// defect from the swap investigation, and each defect was a FALSE NEGATIVE
// during development -- the lint passed on code that reproduced the exact bug
// it was written to catch. Both were found only by deliberately reintroducing
// the bug and watching it stay silent.
//
//   lint-check-questions: `\\b(?:is|has)(?:Unspent|...)` never matched
//     `scriptHasUnspent`, because `h` and `U` are one word with no boundary
//     between them. It reported "clean" on the real defect.
//   lint-covenant-node: the scope walk started brace-counting on the line
//     holding the parameter list's closing paren, which is the same line as the
//     body's opening brace, so every function's body came out one line long
//     and no scope ever contained a connect() call.
//
// So: this suite injects each real defect into a scratch copy of the tree and
// requires the lint to FAIL, then requires it to pass on the fixed code and on
// legitimate neighbours. If a lint stops catching its own bug, this goes red.
//
// Offline, hermetic, no network and no wallet.

import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

/** A throwaway copy of lib/ and scripts/, so injections cannot touch the repo. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'lint-proof-'));
  mkdirSync(join(dir, 'lib'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  cpSync(join(ROOT, 'lib'), join(dir, 'lib'), { recursive: true });
  cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true });
  return dir;
}

/** Run a lint inside a scratch tree; returns true when it reported CLEAN. */
function lintSaysClean(dir, lint) {
  try {
    const out = execFileSync('node', [join(dir, 'scripts', lint)], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.includes(': clean');
  } catch (e) {
    // A non-zero exit is the lint FAILING, which is the interesting case.
    return false;
  }
}

function inject(dir, name, source) {
  writeFileSync(join(dir, 'lib', name), source);
}

// ---------------------------------------------------------------------------
console.log('lint-check-questions: does it catch a container-scoped exact check?\n');

{
  const dir = scratch();
  inject(dir, 'inject-gate.mjs', `export async function scriptHasUnspent(lockingScriptHex, { network = 'mainnet' } = {}) {
  const list = await fetchUnspent(hashOf(lockingScriptHex));
  if (list.length > 0) return 'unspent';
  return 'spent';
}
`);
  check('flags scriptHasUnspent(lockingScriptHex)',
    !lintSaysClean(dir, 'lint-check-questions.mjs'));
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = scratch();
  inject(dir, 'inject-liveness.mjs', `export async function hasUnspentOutput(lockingScriptHex) {
  const list = await listUnspent(hashOf(lockingScriptHex));
  return list.length > 0;
}
`);
  check('flags hasUnspentOutput(lock) -- the other word order',
    !lintSaysClean(dir, 'lint-check-questions.mjs'));
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = scratch();
  inject(dir, 'inject-honest.mjs', `export async function lockHasAnyUnspent(lockingScriptHex) {
  const list = await listUnspent(hashOf(lockingScriptHex));
  return list.length > 0;
}
`);
  check('allows a container-scoped check that says so in its name',
    lintSaysClean(dir, 'lint-check-questions.mjs'));
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = scratch();
  inject(dir, 'inject-innocent.mjs', `export function parseHex(h) { return Buffer.from(h, 'hex'); }
export function isSpent(v) { return v === 'spent'; }
export async function quote(sell, buy) { return { amount: 0 }; }
`);
  check('leaves unrelated functions alone',
    lintSaysClean(dir, 'lint-check-questions.mjs'));
  rmSync(dir, { recursive: true, force: true });
}

check('the real tree passes it',
  lintSaysClean(ROOT, 'lint-check-questions.mjs'));

// ---------------------------------------------------------------------------
console.log('\nlint-covenant-node: does it catch a covenant read on a blind node?\n');

{
  const dir = scratch();
  inject(dir, 'inject-parent.mjs', `export async function checkPoolInputs(builtInputs, w) {
  const client = await connect(w.network);
  const stale = [];
  for (const inp of builtInputs) {
    const txid = Buffer.from(inp.outpointTransactionHash).toString('hex');
    const parent = await client.request('blockchain.transaction.get', txid, false);
    if (parent === null) stale.push(txid);
  }
  return stale;
}
`);
  check('flags a pool-parent read through connect()',
    !lintSaysClean(dir, 'lint-covenant-node.mjs'));
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = scratch();
  inject(dir, 'inject-token.mjs', `export async function collectFunding(addrs, w) {
  const client = await connect(w.network);
  const out = [];
  for (const a of addrs) {
    const utxos = await listUnspent(client, scripthashForAddress(a.address));
    for (const u of utxos) if (u.token_data) out.push(u);
  }
  return out;
}
`);
  check('allows token UTXOs on the wallet own P2PKH addresses',
    lintSaysClean(dir, 'lint-covenant-node.mjs'),
    'a rule this broad would teach people to disable it');
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = scratch();
  inject(dir, 'inject-send.mjs', `export async function sendBch(address, sats, w) {
  const client = await connect(w.network);
  return broadcastViaElectrum(client, buildSend(address, sats));
}
`);
  check('allows an ordinary BCH send through connect()',
    lintSaysClean(dir, 'lint-covenant-node.mjs'));
  rmSync(dir, { recursive: true, force: true });
}

check('the real tree passes it',
  lintSaysClean(ROOT, 'lint-covenant-node.mjs'));

console.log(`\nRESULT: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed === 0 ? 0 : 1);
