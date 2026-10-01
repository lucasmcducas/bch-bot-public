// scripts/test-signer-binding.mjs
//
// The signer used to trust the router's choice of inputs completely.
// signExternalTransaction signed whatever indices the router named in
// inputsToSign, and swap.mjs resolved each one positionally into the funding
// array -- so a router naming an input we had not selected would still get a
// valid signature, because SIGHASH_ALL binds the transaction but nothing bound
// WHICH transaction to the caller's funding set.
//
// These tests assert that a mismatched outpoint is refused, and that a matching
// one still signs. The byte-order question is real: the router supplies the
// internal txid order while callers usually hold the display order, so both are
// accepted and a genuinely different txid is not.

import {
  generateTransaction, encodeTransaction, decodeTransactionBCH,
  walletTemplateToCompilerBCH, importWalletTemplate, walletTemplateP2pkhNonHd,
} from '@bitauth/libauth';

import { signExternalTransaction } from '../lib/sign.mjs';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}`); console.log(`      ${e.message}`); failed++; }
}
function ok(v, m) { if (!v) throw new Error(m); }
async function refuses(fn, re, label) {
  try { await fn(); } catch (e) {
    if (re.test(e.message)) return e;
    throw new Error(`${label}: wrong error: ${e.message}`);
  }
  throw new Error(`${label}: expected a refusal`);
}

const COMPILER = walletTemplateToCompilerBCH(importWalletTemplate(walletTemplateP2pkhNonHd));
const K1 = new Uint8Array(32).fill(1);
const K2 = new Uint8Array(32).fill(2);
const PREV_BIN = new Uint8Array(Buffer.from('76a9140102030405060708090a0b0c0d0e0f1011121388ac', 'hex'));
const OUT_LOCK = new Uint8Array([0x76, 0xa9, 0x14, ...new Array(20).fill(3), 0x88, 0xac]);

// fill -> the byte value every byte of that input's outpoint txid.
const INPUT_FILLS = { 0: 0x11, 1: 0x22 };
const input = (priv, index) => ({
  outpointTransactionHash: new Uint8Array(32).fill(INPUT_FILLS[index]),
  outpointIndex: 0,
  sequenceNumber: 0,
  unlockingBytecode: {
    compiler: COMPILER, script: 'unlock', valueSatoshis: 10000n,
    data: { keys: { privateKeys: { key: priv } } },
  },
});

const generated = generateTransaction({
  inputs: [input(K1, 0), input(K2, 1)],
  outputs: [{ lockingBytecode: OUT_LOCK, valueSatoshis: 18000n }],
  locktime: 0, version: 2,
});
if (generated.success === false) throw new Error('fixture generation failed');
const decoded = decodeTransactionBCH(encodeTransaction(generated.transaction));
decoded.inputs[1].unlockingBytecode = new Uint8Array(0);
const unsignedHex = Buffer.from(encodeTransaction(decoded)).toString('hex');

// The txid as the router reports it (internal byte order) and as a caller
// usually holds it (display order). Note Uint8Array.toString() is comma-
// separated, not hex, so Buffer is used on both sides.
const internalTxid = (i) => Buffer.from(new Uint8Array(32).fill(INPUT_FILLS[i])).toString('hex');
const displayTxid = (i) => Buffer.from(new Uint8Array(32).fill(INPUT_FILLS[i])).reverse().toString('hex');

const sourceOutputs = () => [
  { value: '10000', lockingScriptHex: PREV_BIN.toString('hex') },
  { value: '10000', lockingScriptHex: PREV_BIN.toString('hex') },
];
const material = (i) => ({ privateKey: i === 0 ? K1 : K2, valueSatoshis: 10000n });

await test('signs when the expected outpoint matches, in internal byte order', async () => {
  const r = await signExternalTransaction({
    unsignedTxHex: unsignedHex, inputsToSign: [0], sourceOutputs: sourceOutputs(),
    expectedInput: () => ({ txid: internalTxid(0), vout: 0 }),
    inputMaterial: material,
  });
  ok(r.txHex, 'expected a signed transaction');
});

await test('signs when the expected outpoint matches, in display byte order', async () => {
  const r = await signExternalTransaction({
    unsignedTxHex: unsignedHex, inputsToSign: [0], sourceOutputs: sourceOutputs(),
    expectedInput: () => ({ txid: displayTxid(0), vout: 0 }),
    inputMaterial: material,
  });
  ok(r.txHex, 'expected a signed transaction');
});

await test('REFUSES when the router points at a different input than we funded', async () => {
  // We funded input 0. The router says "sign input 0", but the caller expects
  // input 0 to be the OTHER utxo. This is the steering case.
  await refuses(
    () => signExternalTransaction({
      unsignedTxHex: unsignedHex, inputsToSign: [0], sourceOutputs: sourceOutputs(),
      expectedInput: () => ({ txid: internalTxid(1), vout: 0 }),
      inputMaterial: material,
    }),
    /Refusing to sign an input the router chose/,
    'mismatched txid',
  );
});

await test('REFUSES when the vout differs', async () => {
  await refuses(
    () => signExternalTransaction({
      unsignedTxHex: unsignedHex, inputsToSign: [0], sourceOutputs: sourceOutputs(),
      expectedInput: () => ({ txid: internalTxid(0), vout: 3 }),
      inputMaterial: material,
    }),
    /Refusing to sign/,
    'mismatched vout',
  );
});

await test('a null expectation skips the check for that index', async () => {
  const r = await signExternalTransaction({
    unsignedTxHex: unsignedHex, inputsToSign: [0], sourceOutputs: sourceOutputs(),
    expectedInput: () => null,
    inputMaterial: material,
  });
  ok(r.txHex, 'expected a signed transaction');
});

await test('omitting expectedInput entirely still signs (back-compat)', async () => {
  const r = await signExternalTransaction({
    unsignedTxHex: unsignedHex, inputsToSign: [0], sourceOutputs: sourceOutputs(),
    inputMaterial: material,
  });
  ok(r.txHex, 'expected a signed transaction');
});

await test('REFUSES an out-of-range input index before checking anything', async () => {
  await refuses(
    () => signExternalTransaction({
      unsignedTxHex: unsignedHex, inputsToSign: [7], sourceOutputs: sourceOutputs(),
      expectedInput: () => null,
      inputMaterial: material,
    }),
    /does not exist/,
    'index out of range',
  );
});

console.log(`\nRESULT: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
