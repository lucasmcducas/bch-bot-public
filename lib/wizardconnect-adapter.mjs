// lib/wizardconnect-adapter.mjs
//
// The WizardConnect wallet side: a WalletAdapter over our HD wallet, so any
// BCH dapp that speaks the protocol can have a transaction signed here instead
// of by a browser extension. The browser becomes a UI; this wallet stays the
// signer.
//
// DERIVATIONS, taken from the spec and from Cashonize's reference
// implementation (cashonize/src/stores/wizardconnectStore.ts). Each is domain
// separated so that no two uses can collide:
//
//   m/44'/145'/0'/0/i   Receive
//   m/44'/145'/0'/1/i   Change
//   m/44'/145'/0'/7/i   Cauldron  (the dapp's defi chain)
//   m/44'/145'/0'/8/0   relay secret, child 0, and NOTHING ELSE
//
// The relay secret is the security-critical one, and the spec's reasoning is
// worth restating because it is easy to get wrong:
//
//   "Relay identity keys are HMAC(dedicated chain key, pairing URI):
//    deterministic per URI so reconnects restore the same Nostr identity,
//    distinct per URI so dapps can't correlate sessions.
//    Chain index 8 keeps the relay secret off the xpub chains shared with
//    dapps."
//
// So: a dedicated chain at index 8, never exposed as an xpub, and the per-URI
// identity is HMAC(that key, uri). Deterministic, so a reload does not orphan a
// session; unlinkable, because the dapp sees one Nostr pubkey per session and
// cannot walk it back to the seed. NOT derived from a spend path, and never
// persisted.
//
// The signing algorithm is likewise the spec's, not ours:
//
//   SIGHASH_ALL | SIGHASH_UTXOS | SIGHASH_FORKID, Schnorr.
//   "the signature commits to the full transaction and all source outputs, so it
//    cannot be grafted onto a different transaction and the dapp cannot
//    misrepresent input amounts."
//
// UTXOS also means a wrong-key signature is simply invalid, which is why the
// reference implementation does not verify the derived key against the locking
// bytecode before signing.
//
// Two placeholder conventions, from the same file:
//
//   41 <65 zero bytes>  the wallet's Schnorr signature goes here
//   21 <33 zero bytes>  the wallet's compressed pubkey goes here
//
// CashScript contracts take a pubkey and a signature as arguments, and a dapp
// only knows cashaddresses, which encode pubkey HASHES. It cannot know either
// value, so it marks the slots with fixed-size zero arrays.

import {
  deriveHdPath,
  deriveHdPrivateNodeChild,
  deriveHdPublicNode,
  encodeHdPublicKey,
  secp256k1,
  generateSigningSerializationBch,
  hash256,
  hmacSha256,
  utf8ToBin,
  hexToBin,
  binToHex,
  decodeTransaction,
  encodeTransaction,
  SigningSerializationFlag,
  hash160,
  encodeLockingBytecodeP2pkh,
} from '@bitauth/libauth';
import { loadHdNode, BCH_COIN_TYPE, DEFAULT_ACCOUNT } from './wallet.mjs';

// hdwalletv1 chain indices. Named to match the enum in @wizardconnect/wallet.
export const DerivationPath = Object.freeze({
  Receive: 0,
  Change: 1,
  Cauldron: 7,
  RELAY: 8,
});

// The wizard chain. Cashonize derives the defi chain from the SAME parent node
// and passes `child_index` values 0/1/7; we keep the relay at 8 so it can never
// be one of those.
const CHAIN_INDICES = [0, 1, 7];
export const RELAY_CHAIN = 8;

const ACCOUNT = DEFAULT_ACCOUNT;
const COIN_TYPE = BCH_COIN_TYPE;

/** The spec's hash type. Fixed, not negotiable per request. */
const WIZ_HASH_TYPE =
  SigningSerializationFlag.allOutputs
  | SigningSerializationFlag.utxos
  | SigningSerializationFlag.forkId;

const SIG_PLACEHOLDER = `41${'00'.repeat(65)}`;
const PUBKEY_PLACEHOLDER = `21${'00'.repeat(33)}`;

/** libauth uses index >= 0x80000000 for hardened. */
const HARDENED = 0x80000000;

/** BIP32 non-hardened ceiling. A dapp derives addresses from an xpub, which cannot do hardened derivation. */
const MAX_NON_HARDENED = 0x80000000n;

function privateChain(hdNode, childIndex) {
  return deriveHdPath(hdNode, `m/44'/${COIN_TYPE}'/${ACCOUNT}'/${childIndex}`);
}

/**
 * Build every chain once. Deriving per call would be correct but wasteful, and
 * the relay secret in particular should be produced once per process so a
 * careless future caller cannot end up with two different identities.
 */
export function buildWizardNodes() {
  const { wallet, hdNode } = loadHdNode();

  const privateChains = new Map();
  for (const childIndex of CHAIN_INDICES) {
    privateChains.set(childIndex, privateChain(hdNode, childIndex));
  }

  // Dedicated chain, child 0, and nothing else. Never exposed as an xpub.
  const relaySecretNode = deriveHdPrivateNodeChild(privateChain(hdNode, RELAY_CHAIN), 0);

  const xpubNetwork = wallet.network === 'testnet' ? 'testnet' : 'mainnet';

  return {
    privateChains,
    relayHmacKey: relaySecretNode.privateKey,
    xpubNetwork,
    // Kept so callers can show the user which chain an address belongs to.
    parentDerivation: `m/44'/${COIN_TYPE}'/${ACCOUNT}'`,
  };
}

/** The WalletAdapter @wizardconnect/wallet expects. */
export function createWizAdapter(nodes = buildWizardNodes()) {
  return {
    walletName: 'bch-bot',
    walletIcon: '',

    // HMAC(dedicated relay key, uri). Deterministic per URI so a reload keeps
    // the same Nostr identity and does not orphan the session; unlinkable
    // because the key never appears in any xpub handed to a dapp.
    getRelayPrivateKey: (uri) => hmacSha256(nodes.relayHmacKey, utf8ToBin(uri)),

    getPublicKey: (path, index) => {
      const chain = nodes.privateChains.get(path);
      if (!chain) throw new Error(`Unsupported derivation path: ${path}`);
      if (index < 0n || index >= MAX_NON_HARDENED) {
        throw new Error(`Unsupported address index: ${index.toString()}`);
      }
      const child = deriveHdPrivateNodeChild(chain, Number(index));
      const pubkey = secp256k1.derivePublicKeyCompressed(child.privateKey);
      if (typeof pubkey === 'string') throw new Error(`Failed to derive public key: ${pubkey}`);
      return pubkey;
    },

    getXpub: (path) => {
      const chain = nodes.privateChains.get(path);
      if (!chain) throw new Error(`Unsupported derivation path: ${path}`);
      return encodeHdPublicKey({ node: deriveHdPublicNode(chain), network: nodes.xpubNetwork }).hdPublicKey;
    },

    // Never called by the library: signing runs through pendingSignRequest so
    // the manager can queue it and the UI can approve it. The reference
    // implementation rejects here for the same reason.
    signTransaction: () => Promise.reject(
      new Error('signTransaction is handled via the pendingSignRequest flow'),
    ),
  };
}

/** P2PKH locking bytecode for one address on a chain, hex. */
export function childLockingBytecode(chain, index) {
  const child = deriveHdPrivateNodeChild(chain, index);
  const pubkey = secp256k1.derivePublicKeyCompressed(child.privateKey);
  if (typeof pubkey === 'string') throw new Error(`Failed to derive public key: ${pubkey}`);
  return binToHex(encodeLockingBytecodeP2pkh(hash160(pubkey)));
}

/** The first `count` addresses of a chain, as locking bytecodes. */
export function chainLockingBytecodes(chain, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(childLockingBytecode(chain, i));
  return out;
}

/**
 * Sign one WizardConnect request.
 *
 * `request` is a WcSignTransactionRequest: { transaction, sourceOutputs, ... }
 * where `transaction` is a raw unsigned hex or a libauth transaction object, and
 * `sourceOutputs` is the parallel array of the UTXOs being spent.
 *
 * `inputKeys` maps input index -> { privateKey, pubkeyCompressed } for the
 * inputs the dapp asked us to sign. The manager builds it from the request's
 * inputPaths; the UI must have approved the request before we get here.
 */
export function createSignedWizTransaction(request, inputKeys) {
  const { transaction: wizTx, sourceOutputs } = request;

  let unsignedTransaction;
  if (typeof wizTx === 'string') {
    unsignedTransaction = decodeTransaction(hexToBin(wizTx));
    if (typeof unsignedTransaction === 'string') {
      throw new Error(`Transaction decode error: ${unsignedTransaction}`);
    }
  } else {
    unsignedTransaction = wizTx;
  }

  if (!Array.isArray(sourceOutputs)) {
    throw new Error('sourceOutputs is required: signing cannot be checked without it');
  }
  if (unsignedTransaction.inputs.length !== sourceOutputs.length) {
    throw new Error('Transaction inputs and sourceOutputs length mismatch');
  }

  const signInput = (inputIndex, coveredBytecode, privateKey) => {
    const context = { inputIndex, sourceOutputs, transaction: unsignedTransaction };
    const signingSerializationType = new Uint8Array([WIZ_HASH_TYPE]);
    const preimage = generateSigningSerializationBch(context, {
      coveredBytecode,
      signingSerializationType,
    });
    const sighash = hash256(preimage);
    const signature = secp256k1.signMessageHashSchnorr(privateKey, sighash);
    if (typeof signature === 'string') throw new Error(`Signature error: ${signature}`);
    return Uint8Array.from([...signature, WIZ_HASH_TYPE]);
  };

  for (const [index, input] of unsignedTransaction.inputs.entries()) {
    const source = sourceOutputs[index];
    const key = inputKeys.get(index);

    if (source?.contract?.artifact?.contractName) {
      // Contract input. The dapp cannot know our pubkey or signature, so it
      // left zero-filled placeholders in the unlocking bytecode. Substitute.
      let unlocking = binToHex(source.unlockingBytecode);

      if (unlocking.includes(SIG_PLACEHOLDER)) {
        if (!key) throw new Error(`No signing key provided in inputPaths for contract input ${index}`);
        // coveredBytecode is the script actually being executed -- the redeem
        // script for a p2sh32 covenant. libauth needs it for the sighash, and
        // getting this wrong is how a covenant signature comes out invalid.
        const coveredBytecode = source.contract.redeemScript;
        if (!coveredBytecode) {
          throw new Error('Not enough information provided, please include contract redeemScript');
        }
        const signature = signInput(index, coveredBytecode, key.privateKey);
        unlocking = unlocking.replace(SIG_PLACEHOLDER, `41${binToHex(signature)}`);
      }

      if (unlocking.includes(PUBKEY_PLACEHOLDER)) {
        if (!key) throw new Error(`No signing key provided in inputPaths for contract input ${index}`);
        unlocking = unlocking.replace(PUBKEY_PLACEHOLDER, `21${binToHex(key.pubkeyCompressed)}`);
      }

      input.unlockingBytecode = hexToBin(unlocking);
    } else if (key) {
      // P2PKH input the dapp asked us to sign, named in inputPaths.
      //
      // The derived key is deliberately NOT checked against the locking
      // bytecode. With SIGHASH_UTXOS a wrong-key signature is simply invalid, so
      // a lookup would cost a round trip and buy nothing.
      const coveredBytecode = source.lockingBytecode;
      if (!coveredBytecode) throw new Error(`sourceOutputs[${index}] has no lockingBytecode`);
      const signature = signInput(index, coveredBytecode, key.privateKey);
      // TWO pushes, not one blob. The P2PKH unlocking script is
      //   <signature+sighash> <pubkey>
      // and lib/sign.mjs builds it the same way (scriptSig[at++] = pubkey.length
      // after the signature push). A single 68-byte push also happens to
      // execute, which is exactly why the first version of this passed a
      // superficial check -- but it is not the encoding the wallet uses and a
      // node applying the standard template is entitled to reject it.
      input.unlockingBytecode = Uint8Array.from([
        signature.length,
        ...signature,
        key.pubkeyCompressed.length,
        ...key.pubkeyCompressed,
      ]);
    }
  }

  const encoded = encodeTransaction(unsignedTransaction);
  if (typeof encoded === 'string') throw new Error(`Transaction encode error: ${encoded}`);
  return { signedTransaction: binToHex(encoded) };
}
