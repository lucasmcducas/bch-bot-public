// scripts/test-swap-outputs.mjs
//
// The last gate before a signature exists. verifyBuildAgainstQuote compares two
// numbers the ROUTER supplied, which a hostile or compromised router can make
// agree with each other while redirecting the recipient output. These tests
// build real transactions with libauth and check that verifyTransactionOutputs
// actually reads the transaction bytes and refuses the bad ones.
//
// The headline case is TEST 5: a router that returns a perfectly
// self-consistent quote AND build, and quietly pays the swap output to an
// address we do not control. That is the whole attack, so it is the one that
// has to fail closed.

import {
  generateTransaction, encodeTransaction, walletTemplateToCompilerBCH,
  importWalletTemplate, walletTemplateP2pkhNonHd, cashAddressToLockingBytecode,
  encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress,
} from '@bitauth/libauth';

import { verifyTransactionOutputs } from '../lib/router.mjs';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
    failed++;
  }
}
function ok(v, m) { if (!v) throw new Error(m); }
function eq(a, b, m = '') { if (a !== b) throw new Error(`${m}expected ${b}, got ${a}`); }
async function refuses(fn, label) {
  const r = await fn();
  if (r.ok) throw new Error(`${label}: expected a refusal, got ok`);
  return r;
}

const COMPILER = walletTemplateToCompilerBCH(importWalletTemplate(walletTemplateP2pkhNonHd));
const K1 = new Uint8Array(32).fill(1);
const K2 = new Uint8Array(32).fill(2);

// Locking bytecode for a given cash address, so a test can pay an arbitrary
// address without hardcoding bytecode.
const lockFor = (addr) => {
  const { bytecode } = cashAddressToLockingBytecode(addr);
  return new Uint8Array(bytecode);
};

const OUR_RECEIVE = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
const OUR_CHANGE = 'bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy';

// A third, valid address that we do NOT control -- the destination a hostile
// router would pay instead. Derived rather than hardcoded: a mistyped cash
// address has a bad checksum, cashAddressToLockingBytecode returns undefined
// for it, and the gate then refuses for the wrong reason -- which would make
// the headline test pass without ever testing the attack.
const ATTACKER = lockingBytecodeToCashAddress({
  bytecode: encodeLockingBytecodeP2pkh(new Uint8Array(20).fill(0xab)),
}).address;

const p2pkh = (fill) => new Uint8Array([0x76, 0xa9, 0x14, ...new Array(20).fill(fill), 0x88, 0xac]);

const input = (priv, fill, index) => ({
  outpointTransactionHash: new Uint8Array(32).fill(fill),
  outpointIndex: index,
  sequenceNumber: 0,
  unlockingBytecode: {
    compiler: COMPILER, script: 'unlock', valueSatoshis: 10000n,
    data: { keys: { privateKeys: { key: priv } } },
  },
});

function buildTx(outputs) {
  const generated = generateTransaction({
    inputs: [input(K1, 9, 0), input(K2, 8, 1)],
    outputs: outputs.map((o) => ({ lockingBytecode: o.lockingBytecode, valueSatoshis: o.valueSatoshis })),
    locktime: 0, version: 2,
  });
  if (generated.success === false) throw new Error('fixture generation failed');
  return Buffer.from(encodeTransaction(generated.transaction)).toString('hex');
}

// --- 1. the happy path -------------------------------------------------------
await test('accepts a swap output plus our own change', async () => {
  const hex = buildTx([
    { lockingBytecode: lockFor(OUR_RECEIVE), valueSatoshis: 100000n },
    { lockingBytecode: lockFor(OUR_CHANGE), valueSatoshis: 90000n },
  ]);
  const r = await verifyTransactionOutputs(hex, {
    expectedReceiveAddresses: [OUR_RECEIVE], changeAddresses: [OUR_CHANGE],
  });
  ok(r.ok, `expected ok, got: ${r.problems.join('; ')}`);
  eq(r.outputs.length, 2, 'output count: ');
  ok(r.outputs[0].isOurs && r.outputs[1].isOurs, 'both outputs should be recognised as ours');
});

// --- 2. the attack ------------------------------------------------------------
await test('REFUSES a swap output redirected to an address we do not control', async () => {
  // A router that redirects the whole receive output to itself. The quote and
  // the build can both claim the right expectedOutput; only reading the bytes
  // catches this.
  const hex = buildTx([
    { lockingBytecode: lockFor(ATTACKER), valueSatoshis: 100000n },
    { lockingBytecode: lockFor(OUR_CHANGE), valueSatoshis: 90000n },
  ]);
  const r = await refuses(
    () => verifyTransactionOutputs(hex, {
      expectedReceiveAddresses: [OUR_RECEIVE], changeAddresses: [OUR_CHANGE], maxFeeSats: 1000n,
    }),
    'redirected receive output'
  );
  ok(r.problems.some((p) => /exceeds the fee ceiling/.test(p)),
    `expected a fee-ceiling problem, got: ${r.problems.join('; ')}`);
});

// --- 3. no ours at all -------------------------------------------------------
await test('REFUSES when no output pays an address we control', async () => {
  const hex = buildTx([
    { lockingBytecode: lockFor(ATTACKER), valueSatoshis: 100000n },
    { lockingBytecode: lockFor(ATTACKER), valueSatoshis: 90000n },
  ]);
  const r = await refuses(
    () => verifyTransactionOutputs(hex, { expectedReceiveAddresses: [OUR_RECEIVE], changeAddresses: [OUR_CHANGE] }),
    'all outputs foreign'
  );
  ok(r.problems.some((p) => /none of the built transaction outputs/.test(p)),
    `expected a no-ours problem, got: ${r.problems.join('; ')}`);
});

// --- 4. a fee output is allowed when it is small and plain --------------------
await test('accepts a small plain P2PKH output as the router fee', async () => {
  const hex = buildTx([
    { lockingBytecode: lockFor(OUR_RECEIVE), valueSatoshis: 100000n },
    { lockingBytecode: lockFor(OUR_CHANGE), valueSatoshis: 90000n },
    { lockingBytecode: p2pkh(200), valueSatoshis: 300n }, // the router's fee
  ]);
  const r = await verifyTransactionOutputs(hex, {
    expectedReceiveAddresses: [OUR_RECEIVE], changeAddresses: [OUR_CHANGE], maxFeeSats: 1000n,
  });
  ok(r.ok, `expected ok, got: ${r.problems.join('; ')}`);
});

// --- 5. a token output is never accepted as a fee ----------------------------
await test('REFUSES a non-P2PKH output even when it is small', async () => {
  // A 260-byte P2PKH output is the shape that carries a CashToken. A tiny
  // value is not enough to make it a fee: it would move an asset, not sats.
  const tokenLock = new Uint8Array(260);
  tokenLock.set(p2pkh(9), 0);
  const hex = buildTx([
    { lockingBytecode: lockFor(OUR_RECEIVE), valueSatoshis: 100000n },
    { lockingBytecode: lockFor(OUR_CHANGE), valueSatoshis: 90000n },
    { lockingBytecode: tokenLock, valueSatoshis: 1n },
  ]);
  const r = await refuses(
    () => verifyTransactionOutputs(hex, {
      expectedReceiveAddresses: [OUR_RECEIVE], changeAddresses: [OUR_CHANGE], maxFeeSats: 1000n,
    }),
    'token-shaped output'
  );
  ok(r.problems.some((p) => /may carry a token/.test(p)),
    `expected a token problem, got: ${r.problems.join('; ')}`);
});

// --- 6. an unparseable address in our own allow-list is an error --------------
await test('REFUSES when one of our own addresses cannot be parsed', async () => {
  const hex = buildTx([{ lockingBytecode: lockFor(OUR_RECEIVE), valueSatoshis: 100000n }]);
  const r = await refuses(
    () => verifyTransactionOutputs(hex, { expectedReceiveAddresses: ['not-an-address'], changeAddresses: [] }),
    'unparseable receive address'
  );
  ok(r.problems.some((p) => /could not parse our own address/.test(p)),
    `expected a parse problem, got: ${r.problems.join('; ')}`);
});

// --- 7. garbage hex fails closed, it does not throw --------------------------
await test('REFUSES hex that is not a transaction', async () => {
  const r = await refuses(() => verifyTransactionOutputs('deadbeef', { expectedReceiveAddresses: [OUR_RECEIVE] }), 'garbage hex');
  ok(r.problems.length > 0, 'expected problems to be reported');
});

await test('REFUSES an empty transaction string', async () => {
  const r = await refuses(() => verifyTransactionOutputs('', { expectedReceiveAddresses: [OUR_RECEIVE] }), 'empty hex');
  ok(r.problems.length > 0, 'expected problems to be reported');
});

// --- 8. a value is always reported, never undefined ---------------------------
await test('every output carries a numeric value', async () => {
  const hex = buildTx([
    { lockingBytecode: lockFor(OUR_RECEIVE), valueSatoshis: 100000n },
    { lockingBytecode: lockFor(OUR_CHANGE), valueSatoshis: 90000n },
  ]);
  const r = await verifyTransactionOutputs(hex, { expectedReceiveAddresses: [OUR_RECEIVE], changeAddresses: [OUR_CHANGE] });
  for (const o of r.outputs) {
    eq(typeof o.valueSatoshis, 'bigint', `output ${o.index} value type: `);
  }
});

console.log(`\nRESULT: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
