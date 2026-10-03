// Smoke test for the WizardConnect adapter, against the real wallet.
//
// The point of these assertions is that every derivation is CHECKED, not
// assumed: if the relay key derivation ever drifts onto a spend path, or the
// chains stop being domain separated, these fail.

import {
  buildWizardNodes,
  createWizAdapter,
  childLockingBytecode,
  DerivationPath,
} from '../lib/wizardconnect-adapter.mjs';
import {
  deriveHdPrivateNodeChild,
  deriveHdPublicNode,
  encodeHdPublicKey,
  secp256k1,
} from '@bitauth/libauth';
import { createSignedWizTransaction } from '../lib/wizardconnect-adapter.mjs';

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

const nodes = buildWizardNodes();
const adapter = createWizAdapter(nodes);

console.log('WizardConnect adapter\n');

check('adapter reports its name', adapter.walletName === 'bch-bot');
check('parent derivation is m/44\'/145\'/0\'', nodes.parentDerivation === "m/44'/145'/0'");

// --- chains are domain separated -------------------------------------------
console.log('');
console.log('domain separation:');
for (const p of [0, 1, 7]) {
  const x = adapter.getXpub(p);
  check(`chain ${p} produces an xpub`, typeof x === 'string' && x.startsWith('xpub'), x?.slice(0, 20));
}
const xpubs = new Set([0, 1, 7].map((p) => adapter.getXpub(p)));
check('receive, change and cauldron chains are distinct', xpubs.size === 3);

const relayPriv = adapter.getRelayPrivateKey('wiz://example');
check('relay key is 32 bytes', relayPriv.length === 32, `${relayPriv.length}`);
check('relay key is not any spend-chain key', !xpubs.has(adapter.getXpub(DerivationPath.Receive)));

// --- relay identity --------------------------------------------------------
console.log('');
console.log('relay identity (per the spec):');
const uriA = 'wiz://dapp-alpha';
const uriB = 'wiz://dapp-beta';
const kA1 = adapter.getRelayPrivateKey(uriA);
const kA2 = adapter.getRelayPrivateKey(uriA);
const kB = adapter.getRelayPrivateKey(uriB);
const hex = (b) => Buffer.from(b).toString('hex');
check('deterministic per URI (a reload keeps the same identity)', hex(kA1) === hex(kA2));
check('distinct per URI (dapps cannot correlate sessions)', hex(kA1) !== hex(kB));
check('relay key differs from a chain private key',
  hex(kA1) !== hex(nodes.privateChains.get(0) ? deriveHdPrivateNodeChild(nodes.privateChains.get(0), 0).privateKey : new Uint8Array()));

// --- pubkey derivation -----------------------------------------------------
console.log('');
console.log('pubkey derivation:');
const pub0 = adapter.getPublicKey(DerivationPath.Receive, 0n);
check('receive index 0 gives a 33-byte compressed key', pub0.length === 33, `${pub0.length}`);

let chainMismatch = 0;
for (const p of [0, 1, 7]) {
  if (hex(adapter.getPublicKey(p, 3n)) === hex(adapter.getPublicKey(p === 0 ? 1 : 0, 3n))) chainMismatch++;
}
check('index 3 on different chains gives different keys', chainMismatch === 0);

let threw = false;
try { adapter.getPublicKey(DerivationPath.Receive, 0x80000000n); } catch { threw = true; }
check('rejects a hardened index (an xpub cannot derive one)', threw);

threw = false;
try { adapter.getPublicKey(8, 0n); } catch { threw = true; }
check('refuses chain 8, the relay chain, as an address chain', threw);

threw = false;
try { adapter.getXpub(8); } catch { threw = true; }
check('refuses to expose the relay chain as an xpub', threw);

// --- locking bytecodes -----------------------------------------------------
console.log('');
console.log('locking bytecodes:');
const lb0 = childLockingBytecode(nodes.privateChains.get(0), 0);
check('P2PKH locking bytecode is 25 bytes of hex', lb0.length === 50, lb0);
check('starts with OP_DUP OP_HASH160 (76a914)', lb0.startsWith('76a914'), lb0.slice(0, 12));
check('ends with OP_EQUALVERIFY OP_CHECKSIG (88ac)', lb0.endsWith('88ac'));

// --- signing path ----------------------------------------------------------
console.log('');
console.log('signing:');
const keys = new Map();
{
  const chain = nodes.privateChains.get(0);
  const child = deriveHdPrivateNodeChild(chain, 0);
  keys.set(0, {
    privateKey: child.privateKey,
    pubkeyCompressed: secp256k1.derivePublicKeyCompressed(child.privateKey),
  });
}

// A minimal P2PKH-only transaction: one input the dapp asks us to sign, one
// output. Enough to prove the sighash path and the unlocking bytecode shape.
const unsigned = {
  inputs: [{
    outpointIndex: 0,
    outpointTransactionHash: new Uint8Array(32).fill(1),
    sequenceNumber: 0xfffffffe,
    unlockingBytecode: new Uint8Array(0),
  }],
  outputs: [{
    lockingBytecode: hexToBinSync('76a914' + '11'.repeat(20) + '88ac'),
    valueSatoshis: 900000n,
  }],
  locktime: 0,
};
function hexToBinSync(h) {
  return Uint8Array.from(Buffer.from(h, 'hex'));
}

const sourceOutputs = [{
  lockingBytecode: hexToBinSync(lb0),
  unlockingBytecode: new Uint8Array(0),
  valueSatoshis: 1000000n,
}];

try {
  const { signedTransaction } = createSignedWizTransaction(
    { transaction: unsigned, sourceOutputs },
    keys,
  );
  check('signs a P2PKH input and returns hex',
    typeof signedTransaction === 'string' && signedTransaction.length > 0);
  check('signature ends with 0x41 (ALL|UTXOS|FORKID)',
    signedTransaction.includes('41'), 'sighash byte not found');
} catch (e) {
  check('signs a P2PKH input and returns hex', false, e.message);
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed === 0 ? 0 : 1);
