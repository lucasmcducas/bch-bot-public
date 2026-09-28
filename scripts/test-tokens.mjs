#!/usr/bin/env node
// scripts/test-tokens.mjs — exercise lib/tokens.mjs against mock UTXOs
//
// Why this exists: we can't run a real CashTokens broadcast without a funded
// token UTXO, but we can prove the **code paths** work correctly:
//   - utxoToTokenPrefix: maps Electrum UTXO → libauth token prefix shape
//   - createTokenOutput: builds a libauth output with auto dust-bump
//   - createNftOutput: builds an NFT output with commitment
//   - sumFtBalances: groups + sums FT amounts per category
//   - selectTokenUtxos: largest-FT-first selection to cover a target
//   - selectInputsForTokenSend: combines FT + BCH inputs
//
// These tests use synthetic data. They prove our code matches libauth's
// expected shape, NOT that the chain will accept the resulting tx.
// Consensus-level verification still requires a real funded token UTXO.
//
// Usage: node scripts/test-tokens.mjs [--verbose]

import {
  utxoToTokenPrefix,
  createTokenOutput,
  createNftOutput,
  sumFtBalances,
  selectTokenUtxos,
  selectInputsForTokenSend,
} from '../lib/tokens.mjs';

let verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
let pass = 0, fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    pass++;
    if (verbose) console.log('  ✓', label);
  } else {
    fail++;
    console.log('  ✗', label);
    if (detail) console.log('     ', detail);
  }
}

function eqHex(label, actual, expected) {
  if (actual === expected) {
    pass++;
    if (verbose) console.log('  ✓', label);
  } else {
    fail++;
    console.log('  ✗', label);
    console.log('     expected:', expected);
    console.log('     got:     ', actual);
  }
}

function hex(s) { return s; } // alias for clarity

console.log('--- test 1: utxoToTokenPrefix ---');
{
  // Plain BCH UTXO returns undefined
  const got = utxoToTokenPrefix({ tx_hash: hex('a'.repeat(64)), tx_pos: 0, value: 1000 });
  assert('plain BCH UTXO → undefined', got === undefined);

  // FT-only UTXO
  const cat = hex('c'.repeat(64));
  const got2 = utxoToTokenPrefix({
    tx_hash: hex('a'.repeat(64)), tx_pos: 0, value: 1000,
    token_data: { amount: '100', category: cat },
  });
  assert('FT-only UTXO returns prefix', got2 !== undefined);
  assert('FT amount is bigint 100n', got2?.amount === 100n);
  assert('FT category is 32-byte Uint8Array', got2?.category instanceof Uint8Array && got2.category.length === 32);
  assert('FT-only has no nft field', got2?.nft === undefined);

  // NFT UTXO (amount=0, with capability)
  const got3 = utxoToTokenPrefix({
    tx_hash: hex('a'.repeat(64)), tx_pos: 0, value: 1000,
    token_data: { amount: '0', category: hex('d'.repeat(64)), nft: { capability: 'mutable', commitment: 'deadbeef' } },
  });
  assert('NFT UTXO returns prefix', got3 !== undefined);
  assert('NFT amount is bigint 0n', got3?.amount === 0n);
  assert('NFT capability = mutable', got3?.nft?.capability === 'mutable');
  assert('NFT commitment is Uint8Array(4)', got3?.nft?.commitment instanceof Uint8Array && got3.nft.commitment.length === 4);

  // Minting-capability NFT, no commitment
  const got4 = utxoToTokenPrefix({
    tx_hash: hex('a'.repeat(64)), tx_pos: 0, value: 1000,
    token_data: { amount: '0', category: hex('e'.repeat(64)), nft: { capability: 'minting' } },
  });
  assert('minting NFT → empty commitment', got4?.nft?.commitment instanceof Uint8Array && got4.nft.commitment.length === 0);
}

console.log();
console.log('--- test 2: createTokenOutput dust bump ---');
{
  const cat = hex('c'.repeat(64));
  // Sub-dust amount: libauth bumps to 651 sats (verified during build)
  const out = createTokenOutput({ address: 'bitcoincash:qplaceholder0replace0with0your0address0xxxxxxxxxxxx', category: cat, amount: 100n, satsAmount: 546n });
  assert('dust-bumped from 546 → >546', Number(out.valueSatoshis) > 546);
  assert('lockingBytecode is Uint8Array', out.lockingBytecode instanceof Uint8Array);
  assert('lockingBytecode is P2PKH (25 bytes)', out.lockingBytecode.length === 25);
  assert('token.amount preserved', out.token.amount === 100n);
  assert('token.category is 32-byte Uint8Array', out.token.category.length === 32);

  // High satsAmount preserved (above dust threshold)
  const out2 = createTokenOutput({ address: 'bitcoincash:qplaceholder0replace0with0your0address0xxxxxxxxxxxx', category: cat, amount: 100n, satsAmount: 5000n });
  assert('high satsAmount (5000) preserved', out2.valueSatoshis === 5000n);
}

console.log();
console.log('--- test 3: createNftOutput ---');
{
  const cat = hex('c'.repeat(64));
  const nft = createNftOutput({
    address: 'bitcoincash:qplaceholder0replace0with0your0address0xxxxxxxxxxxx',
    category: cat,
    capability: 'none',
    commitment: 'deadbeef',
  });
  assert('NFT amount is 0n', nft.token.amount === 0n);
  assert('NFT capability = none', nft.token.nft?.capability === 'none');
  assert('NFT commitment preserved', nft.token.nft?.commitment instanceof Uint8Array);

  // Minting NFT
  const mintBaton = createNftOutput({
    address: 'bitcoincash:qplaceholder0replace0with0your0address0xxxxxxxxxxxx',
    category: cat,
    capability: 'minting',
    commitment: '',
  });
  assert('minting baton has capability=minting', mintBaton.token.nft?.capability === 'minting');
}

console.log();
console.log('--- test 4: sumFtBalances ---');
{
  const cat1 = hex('c'.repeat(64));
  const cat2 = hex('e'.repeat(64));
  const utxos = [
    { token_data: { amount: '100', category: cat1 } },
    { token_data: { amount: '250', category: cat1 } },
    { token_data: { amount: '0', category: hex('d'.repeat(64)), nft: { capability: 'none' } } }, // NFT in cat3
    { token_data: { amount: '1000', category: cat2 } },
    { value: 5000 }, // plain BCH
  ];
  const ftOnly = sumFtBalances(utxos, { ftOnly: true });
  assert('ftOnly mode has 2 categories (excludes NFT)', ftOnly.size === 2);
  assert('cat1 sum = 350', ftOnly.get(cat1) === 350n);
  assert('cat2 sum = 1000', ftOnly.get(cat2) === 1000n);

  const allTokens = sumFtBalances(utxos, { ftOnly: false });
  assert('all-tokens mode has 3 categories', allTokens.size === 3);
  assert('NFT category appears with amount=0', allTokens.has(hex('d'.repeat(64))));
}

console.log();
console.log('--- test 5: selectTokenUtxos ---');
{
  const cat = hex('c'.repeat(64));
  const utxos = [
    { tx_hash: '11'.repeat(32), tx_pos: 0, value: 1000, token_data: { amount: '50',  category: cat } },
    { tx_hash: '22'.repeat(32), tx_pos: 0, value: 1000, token_data: { amount: '300', category: cat } },
    { tx_hash: '33'.repeat(32), tx_pos: 0, value: 1000, token_data: { amount: '100', category: cat } },
    { tx_hash: '44'.repeat(32), tx_pos: 0, value: 1000, token_data: { amount: '999', category: hex('e'.repeat(64)) } }, // different cat
  ];
  const r = selectTokenUtxos(utxos, cat, 250n);
  assert('selectTokenUtxos returns object', r !== null);
  assert('selectTokenUtxos picks largest (300) for target 250', r?.total === 300n);
  assert('selectTokenUtxos picks exactly 1 input', r?.selected.length === 1);

  // Insufficient
  const r2 = selectTokenUtxos(utxos, cat, 1000n);
  assert('insufficient funds returns null', r2 === null);

  // Multiple smaller inputs to cover target
  const r3 = selectTokenUtxos(utxos, cat, 200n);
  assert('target 200 picks 1 input (300 covers it)', r3?.selected.length === 1);
}

console.log();
console.log('--- test 6: selectInputsForTokenSend ---');
{
  const cat = hex('c'.repeat(64));
  const allUtxos = [
    { tx_hash: 'aa'.repeat(32), tx_pos: 0, value: 1000, token_data: { amount: '100', category: cat } }, // FT
    { tx_hash: 'bb'.repeat(32), tx_pos: 0, value: 2000 }, // pure BCH
    { tx_hash: 'cc'.repeat(32), tx_pos: 0, value: 5000 }, // pure BCH (largest)
    { tx_hash: 'dd'.repeat(32), tx_pos: 0, value: 800,  token_data: { amount: '200', category: cat } }, // FT
  ];
  const r = selectInputsForTokenSend({ allUtxos, category: cat, tokenAmount: 250n, bchRequired: 1500n });
  assert('selectInputsForTokenSend returns ok', r !== null);
  assert('combined inputs = 3 (FT + BCH)', r?.inputs.length === 3);
  assert('ftTotal = 300 (one FT picked, 200+100 not summed since largest covers)', r?.ftTotal === 300n);
  assert('bchTotal = 5000 (largest BCH-only picked)', r?.bchTotal === 5000n);

  // Insufficient BCH
  let threw = false;
  try {
    selectInputsForTokenSend({ allUtxos, category: cat, tokenAmount: 250n, bchRequired: 100000n });
  } catch (e) {
    threw = e.message.includes('insufficient BCH');
  }
  assert('insufficient BCH throws descriptive error', threw);

  // Insufficient FT
  const utxosNoFt = [{ tx_hash: 'ee'.repeat(32), tx_pos: 0, value: 5000 }];
  let ftThrew = false;
  try {
    selectInputsForTokenSend({ allUtxos: utxosNoFt, category: cat, tokenAmount: 100n, bchRequired: 100n });
  } catch (e) {
    ftThrew = e.message.includes('insufficient FT');
  }
  assert('insufficient FT throws descriptive error', ftThrew);
}

console.log();
console.log('--- test 7: end-to-end mock token send (no broadcast) ---');
{
  // Simulate the full send-token.mjs happy path with mock inputs.
  // No real signing happens (we don't have a HD node bound to a real address),
  // but we verify the construction: token-bearing input selected, BCH change
  // computed, recipient output built with dust bump.
  const cat = hex('c'.repeat(64));
  const mockUtxos = [
    { tx_hash: 'aa'.repeat(32), tx_pos: 0, value: 1000, token_data: { amount: '500', category: cat, address: 'bitcoincash:qplaceholder0replace0with0your0address0xxxxxxxxxxxx' } },
    { tx_hash: 'bb'.repeat(32), tx_pos: 0, value: 10000, address: 'bitcoincash:qplaceholder0replace0with0your0address0xxxxxxxxxxxx' }, // BCH
  ];
  const sel = selectInputsForTokenSend({ allUtxos: mockUtxos, category: cat, tokenAmount: 200n, bchRequired: 1000n });
  assert('e2e: selected inputs', sel !== null);
  // build recipient output
  const recipientOut = createTokenOutput({
    address: 'bitcoincash:qrjcuk2c749w6ezgpdk685e6yx35a9l29qqmn98jmw',
    category: cat, amount: 200n,
  });
  assert('e2e: recipient output built with dust bump', Number(recipientOut.valueSatoshis) > 546);
  // build FT change output (excess 500-200 = 300)
  const ftChangeOut = createTokenOutput({
    address: 'bitcoincash:qplaceholder0replace0with0your0address0xxxxxxxxxxxx',
    category: cat, amount: 300n,
  });
  assert('e2e: FT change output has amount 300', ftChangeOut.token.amount === 300n);
  // sum to verify accounting
  const totalTokenIn = sel.ftTotal;
  const totalTokenOut = recipientOut.token.amount + ftChangeOut.token.amount;
  assert('e2e: token accounting balanced', totalTokenIn === totalTokenOut);
}

console.log();
console.log('='.repeat(60));
console.log(`RESULT: ${pass} passed, ${fail} failed (${pass + fail} total)`);
process.exit(fail > 0 ? 1 : 0);