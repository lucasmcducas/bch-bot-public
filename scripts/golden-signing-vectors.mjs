// Golden vectors: sign a fixed transaction with a fixed key and print the
// signatures, so an upgrade can be proven to change nothing.
//
// This is the whole point. "The tests pass" is weak evidence after a crypto
// dependency bump -- a test can pass on a signature that is merely plausible.
// These print the actual sighash and signature bytes, so a diff is proof.
//
// The key and transaction are constructed in-process from a fixed seed, so the
// vectors are identical on every run and on every machine.

import {
  secp256k1,
  generateSigningSerializationBCH,
  SigningSerializationFlag,
  hash256,
} from '@bitauth/libauth';
import { deriveSeedFromBip39Mnemonic, deriveHdPrivateNodeFromSeed, deriveHdPath } from '@bitauth/libauth';

// A well-known throwaway seed. This key protects nothing and holds no funds.
const SEED_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = deriveSeedFromBip39Mnemonic(SEED_PHRASE);
const root = deriveHdPrivateNodeFromSeed(seed, { assumeValidity: true });
const node = deriveHdPath(root, "m/44'/145'/0'/0/0");

const hashType = SigningSerializationFlag.allOutputs
  | SigningSerializationFlag.utxos
  | SigningSerializationFlag.forkId;

const sourceOutputs = [
  { valueSatoshis: 1000000n, lockingBytecode: Uint8Array.from(Buffer.from('76a914' + 'aa'.repeat(20) + '88ac', 'hex')) },
];

const transaction = {
  version: 2,
  locktime: 0,
  inputs: [{
    outpointIndex: 0,
    outpointTransactionHash: Uint8Array.from(Buffer.from('11'.repeat(32), 'hex')),
    sequenceNumber: 0xfffffffe,
    unlockingBytecode: new Uint8Array(0),
  }],
  outputs: [{ lockingBytecode: Uint8Array.from(Buffer.from('76a914' + 'bb'.repeat(20) + '88ac', 'hex')), valueSatoshis: 900000n }],
};

const context = { inputIndex: 0, sourceOutputs, transaction };
const serialization = generateSigningSerializationBCH(context, {
  coveredBytecode: sourceOutputs[0].lockingBytecode,
  signingSerializationType: new Uint8Array([hashType]),
});
const sighash = hash256(serialization);
const signature = secp256k1.signMessageHashSchnorr(node.privateKey, sighash);
if (typeof signature === 'string') throw new Error(signature);

const hex = (b) => Buffer.from(b).toString('hex');

console.log('golden-signing-vectors');
console.log('  libauth           ', (await import('@bitauth/libauth/package.json', { with: { type: 'json' } }).catch(() => ({ default: { version: '?' } }))).default?.version ?? '?');
console.log('  hashType          ', hashType, '(0x' + hashType.toString(16) + ')');
console.log('  pubkey            ', hex(secp256k1.derivePublicKeyCompressed(node.privateKey)));
console.log('  serialization len ', serialization.length);
console.log('  serialization     ', hex(serialization));
console.log('  sighash           ', hex(sighash));
console.log('  signature         ', hex(signature));
