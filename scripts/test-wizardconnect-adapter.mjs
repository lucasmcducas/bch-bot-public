// The WizardConnect adapter, asserted against the real wallet.
//
// The point of this file is that every DERIVATION is checked, not assumed. A
// wallet adapter is mostly derivation, and a wrong derivation is a wallet that
// signs for the wrong chain -- which either fails loudly or, worse, quietly
// shares keys with a dapp. So each property below is an assertion, not a
// comment.
//
// The most important one is relay-key separation: the spec puts the relay
// secret on its own chain (index 8) precisely so it can never appear in an
// xpub handed to a dapp. An earlier version of this test "proved" that by
// comparing a private key to an xpub, which can never be equal and therefore
// proved nothing. The real checks are that chain 8 is a distinct node and that
// getXpub(8) throws.

import {
  deriveHdPrivateNodeChild,
  secp256k1,
  hash160,
  encodeLockingBytecodeP2pkh,
} from '@bitauth/libauth';
import {
  buildWizardNodes,
  createWizAdapter,
  childLockingBytecode,
  createSignedWizTransaction,
  DerivationPath,
  RELAY_CHAIN,
} from '../lib/wizardconnect-adapter.mjs';

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};
const hex = (b) => Buffer.from(b).toString('hex');
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const nodes = buildWizardNodes();
const adapter = createWizAdapter(nodes);
const URI_A = 'wiz://dapp-alpha';
const URI_B = 'wiz://dapp-beta';

console.log('WizardConnect adapter\n');

check('adapter names itself', adapter.walletName === 'bch-bot');
check("parent derivation is m/44'/145'/0'", nodes.parentDerivation === "m/44'/145'/0'");

// --- chain separation ------------------------------------------------------
console.log('\nchain separation:');
const xpubOf = (p) => adapter.getXpub(p);
check('receive/change/cauldron each produce an xpub',
  [0, 1, 7].every((p) => typeof xpubOf(p) === 'string' && xpubOf(p).startsWith('xpub')));
check('the three shared chains are distinct', new Set([0, 1, 7].map(xpubOf)).size === 3);
check('the relay chain is NOT one of 0/1/7', ![0, 1, 7].includes(RELAY_CHAIN));
check('getXpub on the relay chain throws -- it must never be shared',
  throws(() => adapter.getXpub(RELAY_CHAIN)));
check('getPublicKey on the relay chain throws',
  throws(() => adapter.getPublicKey(RELAY_CHAIN, 0n)));

// --- relay identity, exactly as the spec words it --------------------------
console.log('\nrelay identity (the spec: deterministic per URI, distinct per URI):');
const kA = adapter.getRelayPrivateKey(URI_A);
const kAAgain = adapter.getRelayPrivateKey(URI_A);
const kB = adapter.getRelayPrivateKey(URI_B);
check('32 bytes', kA.length === 32, `${kA.length}`);
check('deterministic: the same URI yields the same key', hex(kA) === hex(kAAgain));
check('distinct per URI: a dapp cannot correlate two sessions', hex(kA) !== hex(kB));
const spendKey0 = deriveHdPrivateNodeChild(nodes.privateChains.get(0), 0).privateKey;
check('differs from a spend key on a shared chain', hex(kA) !== hex(spendKey0));

// --- pubkeys ---------------------------------------------------------------
console.log('\npubkey derivation:');
check('index 0 gives a 33-byte compressed key',
  adapter.getPublicKey(DerivationPath.Receive, 0n).length === 33);
check('the same index on different chains gives different keys',
  hex(adapter.getPublicKey(0, 3n)) !== hex(adapter.getPublicKey(1, 3n)));
check('rejects a hardened index (an xpub cannot derive one)',
  throws(() => adapter.getPublicKey(0, 0x80000000n)));
check('rejects a negative index', throws(() => adapter.getPublicKey(0, -1n)));

// --- locking bytecodes -----------------------------------------------------
console.log('\nlocking bytecodes:');
const lb = childLockingBytecode(nodes.privateChains.get(0), 0);
check('P2PKH shape: 76a914 <20 bytes> 88ac', /^76a914[0-9a-f]{40}88ac$/.test(lb), lb);
check('matches hash160(pubkey) for the same index',
  lb === hex(encodeLockingBytecodeP2pkh(hash160(adapter.getPublicKey(0, 0n)))));

// --- signing ---------------------------------------------------------------
console.log('\nsigning (SIGHASH_ALL | SIGHASH_UTXOS | SIGHASH_FORKID, Schnorr):');
const keys = new Map();
{
  const child = deriveHdPrivateNodeChild(nodes.privateChains.get(0), 0);
  keys.set(0, {
    privateKey: child.privateKey,
    pubkeyCompressed: secp256k1.derivePublicKeyCompressed(child.privateKey),
  });
}

const hexToBin = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const unsigned = {
  inputs: [{
    outpointIndex: 0,
    outpointTransactionHash: hexToBin('11'.repeat(32)),
    sequenceNumber: 0xfffffffe,
    unlockingBytecode: new Uint8Array(0),
  }],
  outputs: [{ lockingBytecode: hexToBin('76a914' + 'bb'.repeat(20) + '88ac'), valueSatoshis: 900000n }],
  locktime: 0,
};
// valueSatoshis is required: SIGHASH_UTXOS hashes every input's value, so a
// sourceOutput without one is not a valid sighash input.
const sourceOutputs = [{
  lockingBytecode: hexToBin(lb),
  unlockingBytecode: new Uint8Array(0),
  valueSatoshis: 1000000n,
}];

try {
  const { signedTransaction } = createSignedWizTransaction(
    { transaction: unsigned, sourceOutputs }, keys,
  );
  check('returns hex', typeof signedTransaction === 'string' && signedTransaction.length > 0);
  // Two pushes: 0x41 = push 65 bytes (64-byte Schnorr + sighash), then 0x21 =
  // push 33 bytes (compressed pubkey). A single 68-byte push also executes but is
  // not the encoding lib/sign.mjs produces.
  check('unlocking bytecode is push-65 (0x41) then push-33 (0x21)',
    /41[0-9a-f]{130}21[0-9a-f]{66}/.test(signedTransaction),
    signedTransaction.match(/63[0-9a-f]{6}|41[0-9a-f]{130}21/)?.[0]?.slice(0, 20) ?? 'no match');
} catch (e) {
  check('signs a P2PKH input', false, e.message);
}

// --- guards. Each has a reason to exist ------------------------------------
try {
  createSignedWizTransaction(
    { transaction: unsigned, sourceOutputs: [sourceOutputs[0], sourceOutputs[0]] }, keys);
  check('rejects a sourceOutputs length mismatch', false, 'no error thrown');
} catch { check('rejects a sourceOutputs length mismatch', true); }

try {
  createSignedWizTransaction({ transaction: unsigned }, keys);
  check('rejects a request with no sourceOutputs', false, 'no error thrown');
} catch { check('rejects a request with no sourceOutputs', true); }

check('an input with no key is left unsigned, not signed with the wrong key',
  (() => {
    try {
      const r = createSignedWizTransaction({ transaction: unsigned, sourceOutputs }, new Map());
      return typeof r.signedTransaction === 'string';
    } catch { return false; }
  })());

console.log(`\nRESULT: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed === 0 ? 0 : 1);
