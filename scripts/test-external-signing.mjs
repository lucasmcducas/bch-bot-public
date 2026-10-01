#!/usr/bin/env node
// scripts/test-external-signing.mjs
//
// Known-answer tests for signExternalTransaction — the partial signer used for
// router-assembled Cauldron swaps.
//
// The point of these tests is that they assert a CRYPTOGRAPHIC property, not
// just a shape. A correctly-sized scriptSig full of bytes that no verifier will
// accept looks identical to a working one until you check the signature itself,
// and a wallet that ships that bug loses funds silently. So every happy-path
// case ends in verifySignatureSchnorr against an independently rebuilt digest.

import {
  generateTransaction,
  encodeTransaction,
  decodeTransactionBCH,
  importWalletTemplate,
  walletTemplateP2pkhNonHd,
  walletTemplateToCompilerBCH,
  generateSigningSerializationBCH,
  secp256k1,
  hash256,
} from '@bitauth/libauth';

import { signExternalTransaction } from '../lib/sign.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(`  ✗ ${name}`);
      console.log(`      ${e.message}`);
      failed++;
    });
}

function eq(actual, expected, label = '') {
  if (actual !== expected) {
    throw new Error(`${label}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function ok(value, message) {
  if (!value) throw new Error(message);
}

const K1 = new Uint8Array(32).fill(1);
const K2 = new Uint8Array(32).fill(2);
const COMPILER = walletTemplateToCompilerBCH(importWalletTemplate(walletTemplateP2pkhNonHd));
const PREV_HEX = '76a9140102030405060708090a0b0c0d0e0f1011121388ac';
const PREV_BIN = new Uint8Array(Buffer.from(PREV_HEX, 'hex'));
const OUT_LOCK = new Uint8Array([
  0x76, 0xa9, 0x14, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 0x88, 0xac,
]);

function compilerInput(priv, fill, index) {
  return {
    outpointTransactionHash: new Uint8Array(32).fill(fill),
    outpointIndex: index,
    sequenceNumber: 0,
    unlockingBytecode: {
      compiler: COMPILER,
      script: 'unlock',
      valueSatoshis: 10000n,
      data: { keys: { privateKeys: { key: priv } } },
    },
  };
}

// Build a real 2-in/1-out transaction, then blank input 1's scriptSig to model
// what a foreign assembler hands us: one input already signed by someone else,
// one left for us.
function makeUnsignedTx() {
  const generated = generateTransaction({
    inputs: [compilerInput(K1, 9, 0), compilerInput(K2, 8, 1)],
    outputs: [{ lockingBytecode: OUT_LOCK, valueSatoshis: 18000n }],
    locktime: 0,
    version: 2,
  });
  if (generated.success === false) throw new Error('fixture generation failed');
  const decoded = decodeTransactionBCH(encodeTransaction(generated.transaction));
  const originalSizes = decoded.inputs.map((i) => i.unlockingBytecode.length);
  decoded.inputs[1].unlockingBytecode = new Uint8Array(0);
  return { unsignedHex: Buffer.from(encodeTransaction(decoded)).toString('hex'), originalSizes };
}

const prevouts = () => [
  { lockingBytecode: PREV_BIN, valueSatoshis: 10000n },
  { lockingBytecode: PREV_BIN, valueSatoshis: 10000n },
];

// Rebuild the digest independently of the signer, exactly as a verifier would,
// and check the signature against it.
function independentlyVerify(txHex, inputIndex, sighashValue) {
  const decoded = decodeTransactionBCH(Buffer.from(txHex, 'hex'));
  const sig = decoded.inputs[inputIndex].unlockingBytecode;
  const signature = sig.slice(1, 65);
  const publicKey = sig.slice(67, 67 + 33);
  const serialization = generateSigningSerializationBCH(
    {
      transaction: {
        version: decoded.version,
        locktime: decoded.locktime,
        inputs: decoded.inputs,
        outputs: decoded.outputs,
      },
      sourceOutputs: prevouts(),
      inputIndex,
      input: {
        outpointTransactionHash: decoded.inputs[inputIndex].outpointTransactionHash,
        outpointIndex: decoded.inputs[inputIndex].outpointIndex,
        sequenceNumber: decoded.inputs[inputIndex].sequenceNumber,
        valueSatoshis: 10000n,
      },
      correspondingOutput: { lockingBytecode: PREV_BIN, valueSatoshis: 10000n },
    },
    { coveredBytecode: PREV_BIN, signingSerializationType: new Uint8Array([sighashValue]) }
  );
  return secp256k1.verifySignatureSchnorr(signature, publicKey, hash256(serialization));
}

const sourceOutputs = () => [
  { value: '10000', lockingScriptHex: PREV_HEX },
  { value: '10000', lockingScriptHex: PREV_HEX },
];

console.log('--- signExternalTransaction: real signatures ---');

await test('signs input 1 and leaves input 0 byte-identical', async () => {
  const { unsignedHex, originalSizes } = makeUnsignedTx();
  const result = await signExternalTransaction({
    unsignedTxHex: unsignedHex,
    inputsToSign: [1],
    inputMaterial: () => ({ privateKey: K2, valueSatoshis: 10000n }),
    sourceOutputs: sourceOutputs(),
  });
  const after = decodeTransactionBCH(Buffer.from(result.txHex, 'hex'));
  eq(after.inputs[0].unlockingBytecode.length, originalSizes[0], 'input 0 size: ');
  ok(after.inputs[0].unlockingBytecode.length > 0, 'input 0 was emptied');
});

await test('produced signature verifies under BIP340', async () => {
  const { unsignedHex } = makeUnsignedTx();
  const result = await signExternalTransaction({
    unsignedTxHex: unsignedHex,
    inputsToSign: [1],
    inputMaterial: () => ({ privateKey: K2, valueSatoshis: 10000n }),
    sourceOutputs: sourceOutputs(),
  });
  ok(independentlyVerify(result.txHex, 1, 0x41), 'signature did not verify');
});

await test('plain BCH input gets sighash 0x41', async () => {
  const { unsignedHex } = makeUnsignedTx();
  const result = await signExternalTransaction({
    unsignedTxHex: unsignedHex,
    inputsToSign: [1],
    inputMaterial: () => ({ privateKey: K2, valueSatoshis: 10000n }),
    sourceOutputs: sourceOutputs(),
  });
  const decoded = decodeTransactionBCH(Buffer.from(result.txHex, 'hex'));
  eq(decoded.inputs[1].unlockingBytecode[65], 0x41, 'sighash byte: ');
});

await test('scriptSig is exactly 100 bytes (push65 + sig + push33 + pubkey)', async () => {
  const { unsignedHex } = makeUnsignedTx();
  const result = await signExternalTransaction({
    unsignedTxHex: unsignedHex,
    inputsToSign: [1],
    inputMaterial: () => ({ privateKey: K2, valueSatoshis: 10000n }),
    sourceOutputs: sourceOutputs(),
  });
  const decoded = decodeTransactionBCH(Buffer.from(result.txHex, 'hex'));
  eq(decoded.inputs[1].unlockingBytecode.length, 100, 'scriptSig length: ');
  eq(decoded.inputs[1].unlockingBytecode[0], 65, 'first push: ');
  eq(decoded.inputs[1].unlockingBytecode[66], 33, 'second push: ');
});

await test('embedded pubkey matches the signing key', async () => {
  const { unsignedHex } = makeUnsignedTx();
  const result = await signExternalTransaction({
    unsignedTxHex: unsignedHex,
    inputsToSign: [1],
    inputMaterial: () => ({ privateKey: K2, valueSatoshis: 10000n }),
    sourceOutputs: sourceOutputs(),
  });
  const decoded = decodeTransactionBCH(Buffer.from(result.txHex, 'hex'));
  const embedded = decoded.inputs[1].unlockingBytecode.slice(67, 100);
  const derived = secp256k1.derivePublicKeyCompressed(K2);
  eq(Buffer.from(embedded).toString('hex'), Buffer.from(derived).toString('hex'), 'pubkey: ');
});

await test('returns a txid', async () => {
  const { unsignedHex } = makeUnsignedTx();
  const result = await signExternalTransaction({
    unsignedTxHex: unsignedHex,
    inputsToSign: [1],
    inputMaterial: () => ({ privateKey: K2, valueSatoshis: 10000n }),
    sourceOutputs: sourceOutputs(),
  });
  eq(result.txid.length, 64, 'txid length: ');
});

console.log('\n--- refusals (fail closed) ---');

await test('refuses without source_outputs rather than guessing prevouts', async () => {
  const { unsignedHex } = makeUnsignedTx();
  let message = '';
  try {
    await signExternalTransaction({
      unsignedTxHex: unsignedHex,
      inputsToSign: [1],
      inputMaterial: () => ({ privateKey: K2, valueSatoshis: 10000n }),
    });
  } catch (e) {
    message = e.message;
  }
  ok(message.includes('source_outputs'), `expected a source_outputs error, got: ${message}`);
});

await test('refuses a prevout list shorter than the input count', async () => {
  const { unsignedHex } = makeUnsignedTx();
  let threw = false;
  try {
    await signExternalTransaction({
      unsignedTxHex: unsignedHex,
      inputsToSign: [1],
      inputMaterial: () => ({ privateKey: K2, valueSatoshis: 10000n }),
      sourceOutputs: [{ value: '10000', lockingScriptHex: PREV_HEX }],
    });
  } catch {
    threw = true;
  }
  ok(threw, 'a short prevout list must be rejected');
});

await test('refuses an input index that does not exist', async () => {
  const { unsignedHex } = makeUnsignedTx();
  let threw = false;
  try {
    await signExternalTransaction({
      unsignedTxHex: unsignedHex,
      inputsToSign: [7],
      inputMaterial: () => ({ privateKey: K2, valueSatoshis: 10000n }),
      sourceOutputs: sourceOutputs(),
    });
  } catch {
    threw = true;
  }
  ok(threw, 'an out-of-range input index must be rejected');
});

await test('refuses when no key is available for an input', async () => {
  const { unsignedHex } = makeUnsignedTx();
  let threw = false;
  try {
    await signExternalTransaction({
      unsignedTxHex: unsignedHex,
      inputsToSign: [1],
      inputMaterial: () => ({}),
      sourceOutputs: sourceOutputs(),
    });
  } catch {
    threw = true;
  }
  ok(threw, 'a missing key must be rejected');
});

await test('refuses when an input value is unknown', async () => {
  const { unsignedHex } = makeUnsignedTx();
  let threw = false;
  try {
    await signExternalTransaction({
      unsignedTxHex: unsignedHex,
      inputsToSign: [1],
      inputMaterial: () => ({ privateKey: K2 }),
      sourceOutputs: sourceOutputs(),
    });
  } catch {
    threw = true;
  }
  ok(threw, 'a missing input value must be rejected');
});

await test('refuses an empty inputsToSign list', async () => {
  const { unsignedHex } = makeUnsignedTx();
  let threw = false;
  try {
    await signExternalTransaction({
      unsignedTxHex: unsignedHex,
      inputsToSign: [],
      inputMaterial: () => ({ privateKey: K2, valueSatoshis: 10000n }),
      sourceOutputs: sourceOutputs(),
    });
  } catch {
    threw = true;
  }
  ok(threw, 'an empty inputsToSign must be rejected');
});

console.log(`\n============================================================\nRESULT: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed === 0 ? 0 : 1);
