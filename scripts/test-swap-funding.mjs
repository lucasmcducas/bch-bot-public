// scripts/test-swap-funding.mjs — pins the token-swap funding bug.
//
// BUG (2026-10-02, real, fixed): swap.mjs's funding filter required every UTXO
// to match the trade's sell side, so a token sell offered NO plain BCH. A token
// swap still needs BCH to pay the miner fee, and a CashToken UTXO carries only
// its own dust-level sats (1000), so the router rejected the set with
// "insufficient_funds: inputs 14188 sats cannot cover outputs 13184 + miner
// fee 1173" while the wallet held 801,000 sats of plain BCH.
//
// The rule this test encodes: a funding UTXO is either the SELL ASSET or the
// COIN. Plain BCH is always coin. Tokens are sell-asset only when they match
// the sell side, and never offered as coin, because the router cannot spend a
// token it was not asked to trade.
//
// Run: node scripts/test-swap-funding.mjs

import { readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

const ROACH = '892cef80a326f92583766abb85562f550fe6a6ff9a7d458067680c720135ff53';
const PUSD = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';

// The filter, reimplemented here so the test pins the RULE rather than
// importing swap.mjs's internals. If swap.mjs regresses, this still passes --
// so also assert the shipped source no longer contains the dropping branch.
function classify(utxo, sellCategory) {
  const isToken = Boolean(utxo.token_data);
  if (isToken && utxo.token_data.category !== sellCategory) return null;
  return {
    value: utxo.value,
    token: isToken ? utxo.token_data : null,
    role: isToken ? 'sell-asset' : 'coin',
  };
}

const WALLET = [
  { value: 800000, token_data: null },                              // plain BCH
  { value: 1000, token_data: { category: ROACH, amount: '100' } },  // 1.00 ROACH
  { value: 1000, token_data: { category: PUSD, amount: '500' } },   // 5.00 PUSD
];

console.log('token sell must still be able to pay a miner fee\n');

test('a token sell includes plain BCH as coin', () => {
  const out = WALLET.map((u) => classify(u, ROACH)).filter(Boolean);
  const coin = out.filter((e) => e.role === 'coin');
  assert(coin.length > 0, 'a token swap needs BCH for the miner fee');
  assert(coin.reduce((a, e) => a + e.value, 0) >= 800000);
});

test('the sell-asset token is included as sell-asset', () => {
  const out = WALLET.map((u) => classify(u, ROACH)).filter(Boolean);
  const sell = out.filter((e) => e.role === 'sell-asset');
  assert(sell.length === 1, 'exactly the matching token');
  assert(sell[0].token.category === ROACH);
});

test('a different token is never offered', () => {
  const out = WALLET.map((u) => classify(u, ROACH)).filter(Boolean);
  assert(!out.some((e) => e.token && e.token.category === PUSD),
    'PUSD must not be offered when selling ROACH');
});

test('a BCH sell offers no token as the sell asset', () => {
  const out = WALLET.map((u) => classify(u, 'bch')).filter(Boolean);
  const sell = out.filter((e) => e.role === 'sell-asset');
  assert(sell.length === 0, 'plain BCH is never a sell-asset role');
  assert(out.some((e) => e.role === 'coin'), 'BCH sells still need coin for fees');
});

test('token UTXOs are never offered as coin', () => {
  // A token the router was not asked to trade is an input it cannot use, and
  // offering it would burn the token to no effect.
  for (const sell of [ROACH, PUSD, 'bch']) {
    const out = WALLET.map((u) => classify(u, sell)).filter(Boolean);
    for (const e of out) {
      if (e.token) assert(e.role === 'sell-asset', 'a token entry must be sell-asset');
    }
  }
});

test('the old failure mode cannot recur: coin sats must exceed a typical fee', () => {
  // The bug produced 2,000 sat of funding against a ~14,000 sat requirement.
  // Assert the shape that would have caught it.
  const out = WALLET.map((u) => classify(u, ROACH)).filter(Boolean);
  const fundingSats = out.reduce((a, e) => a + e.value, 0);
  assert(fundingSats > 14000,
    `funding ${fundingSats} sat could not cover outputs + fee; the token-sell filter is probably back`);
});

console.log('\nthe shipped source must not contain the dropping branch\n');

// Read swap.mjs by a path anchored to THIS FILE, not to the process cwd.
// `new URL('../scripts/swap.mjs', import.meta.url)` from scripts/ resolves to
// scripts/scripts/swap.mjs, which does not exist, and the ENOENT was swallowed
// by an un-awaited async test -- so both source assertions passed forever
// regardless of what swap.mjs contained. Anchor on import.meta.url and let a
// read failure abort loudly.
const { readFile } = await import('node:fs/promises');
const { fileURLToPath } = await import('node:url');
const path = await import('node:path');

const SWAP_MJS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'swap.mjs');

test('the swap source file is actually readable', () => {
  // If this fails, every source assertion below is meaningless.
  const src = readFileSync(SWAP_MJS, 'utf8');
  assert(src.length > 1000, `${SWAP_MJS} looks wrong (${src.length} bytes)`);
});

test('swap.mjs no longer drops plain BCH on a token sell', () => {
  const src = readFileSync(SWAP_MJS, 'utf8');
  const drops = /else if \(sellTok\.categoryId !== 'bch'\)\s*\{\s*continue;/.test(src);
  assert(!drops, "the `continue` that excluded plain BCH on a token sell is back");
});

test('swap.mjs tags funding entries with a role', () => {
  const src = readFileSync(SWAP_MJS, 'utf8');
  assert(src.includes("role: isToken ? 'sell-asset' : 'coin'"),
    'funding entries should be tagged so the log can name which side ran out');
});

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
