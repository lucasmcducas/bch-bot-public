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

const PUSD = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';

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

// --- 5. a token output is never accepted silently ----------------------------
await test('REFUSES a CashToken output when the swap is selling plain BCH', async () => {
  // A 68-byte output: 25-byte P2PKH locking script plus the `aa 20 <category>
  // <amount>` fungible prefix. This is the real CashToken output shape, and it
  // is not what a covenant looks like -- a covenant is 35 bytes starting aa 20
  // with nothing before it. A BCH swap must not be moving a token.
  const p2pkhPrefix = p2pkh(9);
  const tokenLock = new Uint8Array(25 + 10 + 32 + 1);
  tokenLock.set(p2pkhPrefix, 0);
  tokenLock[25] = 0xaa; tokenLock[26] = 0x20;
  const hex = buildTx([
    { lockingBytecode: lockFor(OUR_RECEIVE), valueSatoshis: 100000n },
    { lockingBytecode: lockFor(OUR_CHANGE), valueSatoshis: 90000n },
    { lockingBytecode: tokenLock, valueSatoshis: 1n },
  ]);
  const r = await refuses(
    () => verifyTransactionOutputs(hex, {
      expectedReceiveAddresses: [OUR_RECEIVE], changeAddresses: [OUR_CHANGE], maxFeeSats: 1000n,
    }),
    'a token output during a BCH swap'
  );
  ok(r.problems.some((p) => /sells BCH, but the transaction has 1 token output/.test(p)),
    `expected a token-category problem, got: ${r.problems.join('; ')}`);
});

await test('REFUSES a token output in a category that was not sold', async () => {
  const p2pkhPrefix = p2pkh(9);
  const tokenLock = new Uint8Array(25 + 10 + 32 + 1);
  tokenLock.set(p2pkhPrefix, 0);
  tokenLock[25] = 0xaa; tokenLock[26] = 0x20;
  Buffer.from(tokenLock).fill(0xee, 27, 59);   // some other category
  const hex = buildTx([
    { lockingBytecode: lockFor(OUR_RECEIVE), valueSatoshis: 100000n },
    { lockingBytecode: tokenLock, valueSatoshis: 1n },
  ]);
  const r = await refuses(
    () => verifyTransactionOutputs(hex, {
      expectedReceiveAddresses: [OUR_RECEIVE], changeAddresses: [OUR_CHANGE], maxFeeSats: 1000n,
      expectedSellTokenCategory: PUSD,
    }),
    'a token output in the wrong category'
  );
  ok(r.problems.some((p) => /but the swap is selling/.test(p)),
    `expected a wrong-category problem, got: ${r.problems.join('; ')}`);
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

// --- 9. no ceiling means refuse, not skip ------------------------------------
await test('REFUSES a foreign output when no fee ceiling is supplied', async () => {
  // The fail-open case. Skipping the comparison when maxFeeSats is null means
  // an unexplained output is accepted without ever being checked -- the wrong
  // direction for a value-moving operation.
  const hex = buildTx([
    { lockingBytecode: lockFor(OUR_RECEIVE), valueSatoshis: 100000n },
    { lockingBytecode: lockFor(OUR_CHANGE), valueSatoshis: 90000n },
    { lockingBytecode: p2pkh(200), valueSatoshis: 300n },
  ]);
  const r = await refuses(
    () => verifyTransactionOutputs(hex, {
      expectedReceiveAddresses: [OUR_RECEIVE], changeAddresses: [OUR_CHANGE],
      // maxFeeSats deliberately omitted.
    }),
    'foreign output with no ceiling'
  );
  ok(r.problems.some((p) => /no fee ceiling was supplied/.test(p)),
    `expected a missing-ceiling problem, got: ${r.problems.join('; ')}`);
});

await test('REFUSES a foreign output when the ceiling is explicitly null', async () => {
  const hex = buildTx([
    { lockingBytecode: lockFor(OUR_RECEIVE), valueSatoshis: 100000n },
    { lockingBytecode: p2pkh(200), valueSatoshis: 300n },
  ]);
  const r = await refuses(
    () => verifyTransactionOutputs(hex, {
      expectedReceiveAddresses: [OUR_RECEIVE], changeAddresses: [], maxFeeSats: null,
    }),
    'explicitly null ceiling'
  );
  ok(r.problems.some((p) => /no fee ceiling was supplied/.test(p)),
    `expected a missing-ceiling problem, got: ${r.problems.join('; ')}`);
});

await test('a zero ceiling accepts only a transaction with no foreign outputs', async () => {
  const clean = buildTx([
    { lockingBytecode: lockFor(OUR_RECEIVE), valueSatoshis: 100000n },
    { lockingBytecode: lockFor(OUR_CHANGE), valueSatoshis: 90000n },
  ]);
  const okResult = await verifyTransactionOutputs(clean, {
    expectedReceiveAddresses: [OUR_RECEIVE], changeAddresses: [OUR_CHANGE], maxFeeSats: 0n,
  });
  ok(okResult.ok, `expected ok with no foreign outputs, got: ${okResult.problems.join('; ')}`);

  const withFee = buildTx([
    { lockingBytecode: lockFor(OUR_RECEIVE), valueSatoshis: 100000n },
    { lockingBytecode: p2pkh(200), valueSatoshis: 300n },
  ]);
  const r = await refuses(
    () => verifyTransactionOutputs(withFee, {
      expectedReceiveAddresses: [OUR_RECEIVE], changeAddresses: [], maxFeeSats: 0n,
    }),
    'zero ceiling with a fee output'
  );
  ok(r.problems.some((p) => /exceeds the fee ceiling of 0/.test(p)),
    `expected a ceiling problem, got: ${r.problems.join('; ')}`);
});

// --- 10. a REAL multi-pool swap shape, reconstructed -------------------------
await test('accepts the 31-output shape a live 28-pool swap actually produces', async () => {
  // The regression this whole change exists for. Verified against a live
  // 1 BCH -> PUSD build, which produces 31 outputs:
  //   0..27  28 p2sh32 pool covenants (aa 20 <32>), values are each pool's
  //          PUSD position in base units, summing to 38 billion -- not sats
  //   28     25-byte P2PKH to our receive address, 1000 sat
  //   29     a 35-byte covenant worth 998 sat -- the ROUTER FEE
  //   30     25-byte P2PKH to our change address
  //
  // The previous version of this function rejected every 35-byte output as
  // "may carry a token", so this transaction failed the check written to
  // verify it. Note that output 29 has the same shape as a pool covenant but is
  // a fee, and that BOTH p2pkh outputs are ours -- so the conservation check
  // must count only NON-ours p2pkh outputs as leakage.
  const covenant = (fill) => new Uint8Array([0xaa, 0x20, ...new Array(32).fill(fill), 0x87]);
  const outputs = [];
  for (let i = 0; i < 28; i++) outputs.push({ lockingBytecode: covenant(i + 1), valueSatoshis: BigInt(1_000_000 * (i + 1)) });
  outputs.push({ lockingBytecode: lockFor(OUR_RECEIVE), valueSatoshis: 1000n });
  outputs.push({ lockingBytecode: covenant(0xfe), valueSatoshis: 998n });       // router fee
  outputs.push({ lockingBytecode: lockFor(OUR_CHANGE), valueSatoshis: 3994173n });
  ok(outputs.length === 31, 'the fixture must have 31 outputs');

  const r = await verifyTransactionOutputs(buildTx(outputs), {
    expectedReceiveAddresses: [OUR_RECEIVE], changeAddresses: [OUR_CHANGE],
    maxFeeSats: 3996n,           // (998 + 1000) * 2, the router's own ceiling
    expectedSellTokenCategory: null,
    expectedPoolCount: 28,
    maxInputValueSats: 5000000n,
  });
  ok(r.ok, `a real 28-pool swap must pass its own check, got: ${r.problems.join('; ')}`);
  eq(r.outputs.filter((o) => o.isOurs).length, 2, 'exactly two outputs are ours: ');
  eq(r.outputs.filter((o) => o.isCovenantOutput).length, 29, '29 covenants (28 pools + 1 fee): ');
});

await test('REFUSES a swap that commits to more pools than the quote used', async () => {
  const covenant = (fill) => new Uint8Array([0xaa, 0x20, ...new Array(32).fill(fill), 0x87]);
  const outputs = [];
  for (let i = 0; i < 30; i++) outputs.push({ lockingBytecode: covenant(i + 1), valueSatoshis: 1_000_000n });
  outputs.push({ lockingBytecode: lockFor(OUR_RECEIVE), valueSatoshis: 1000n });
  outputs.push({ lockingBytecode: lockFor(OUR_CHANGE), valueSatoshis: 900000n });
  const r = await refuses(
    () => verifyTransactionOutputs(buildTx(outputs), {
      expectedReceiveAddresses: [OUR_RECEIVE], changeAddresses: [OUR_CHANGE],
      maxFeeSats: 3996n, expectedPoolCount: 28, maxInputValueSats: 5000000n,
    }),
    'more pools committed than quoted'
  );
  ok(r.problems.some((p) => /pool covenant\(s\), but the router quoted/.test(p)),
    `expected a pool-count problem, got: ${r.problems.join('; ')}`);
});

await test('REFUSES a plain BCH payment to a stranger beyond the fee ceiling', async () => {
  // The conservation check: sats leaving to an address we do not control must
  // be bounded by the fee, whether the output is a covenant or a plain P2PKH.
  const hex = buildTx([
    { lockingBytecode: lockFor(OUR_RECEIVE), valueSatoshis: 1000n },
    { lockingBytecode: lockFor(OUR_CHANGE), valueSatoshis: 1000n },
    { lockingBytecode: p2pkh(200), valueSatoshis: 500000n },   // 0.005 BCH to a stranger
  ]);
  const r = await refuses(
    () => verifyTransactionOutputs(hex, {
      expectedReceiveAddresses: [OUR_RECEIVE], changeAddresses: [OUR_CHANGE],
      maxFeeSats: 3996n, maxInputValueSats: 5000000n,
    }),
    'a large unattributed plain output'
  );
  ok(r.problems.some((p) => /exceeds the fee ceiling|not a fee, it is a payment/.test(p)),
    `expected a ceiling problem, got: ${r.problems.join('; ')}`);
});

console.log(`\nRESULT: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
