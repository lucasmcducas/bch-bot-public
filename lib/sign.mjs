// lib/sign.mjs — P2PKH transaction signing via libauth's compiler
//
// Pattern from Selene Wallet TransactionBuilderService.compileP2pkhTransaction
// + KeyManagerService.signInputs:
//   1. importWalletTemplate(walletTemplateP2pkhNonHd) — libauth's built-in P2PKH template
//   2. walletTemplateToCompilerBCH(template) — BCH-flavored compiler
//   3. For each input, build an unlocking bytecode that references the compiler + private key
//   4. generateTransaction({ inputs, outputs, locktime, version: 2 }) — runs compiler
//   5. encodeTransaction(result.transaction) -> raw bytes
//
// This is the SIMPLE path (BCH only, no CashTokens). For CashTokens we'll add
// generateSigningSerializationBCH + signMessageHashSchnorr in Phase 2.

import {
  importWalletTemplate,
  walletTemplateP2pkhNonHd,
  walletTemplateToCompilerBCH,
  generateTransaction,
  encodeTransaction,
  cashAddressToLockingBytecode,
  secp256k1,
} from '@bitauth/libauth';

import { binToHex } from './hex.mjs';
import { deriveChildPrivKey } from './wallet.mjs';
import { utxoToTokenPrefix } from './tokens.mjs';

/** Convert a cashaddr string to its locking bytecode (Uint8Array). */
export function addressToLockingBytecode(address) {
  const r = cashAddressToLockingBytecode(address);
  if (typeof r === 'string') throw new Error(`address decode failed: ${r}`);
  return r.bytecode;
}

/** Convert satoshis to libauth output shape. */
export function outputToLibauth({ address, valueSatoshis, token }) {
  return {
    lockingBytecode: addressToLockingBytecode(address),
    valueSatoshis: BigInt(valueSatoshis),
    token, // undefined for BCH-only
  };
}

/**
 * Sign a P2PKH-only transaction.
 *
 * @param {object} args
 * @param {Array<{tx_hash, tx_pos, valueSatoshis, address, hdNode, account?, change?, index?}>} args.inputs
 * @param {Array<{address, valueSatoshis}>} args.outputs
 * @returns {Promise<{ tx_hex: string, tx_hash: string, fee: bigint }>}
 *
 * The signing pattern is the same as Selene's compileP2pkhTransaction but without
 * the BIP69 sort (we leave that to callers — they have already chosen inputs/outputs).
 */
/**
 * Sign a P2PKH-only transaction. Selene's proven pattern (confirmed in production 2026-09):
 * use libauth's shipped `walletTemplateP2pkhNonHd` which signs with
 * `SIGHASH_ALL | SIGHASH_FORKID` = 0x41. This works for plain-BCH P2PKH sends
 * AND for token-bearing P2PKH sends. Do NOT change to 0x61 unless using the
 * manual signing-serialization path (Phase 3 work).
 *
 * @param {object} args
 * @param {Array<{tx_hash, tx_pos, valueSatoshis, address, hdNode, account?, change?, index?}>} args.inputs
 * @param {Array<{address, valueSatoshis, token?}>} args.outputs
 * @returns {Promise<{ tx_hex: string, tx_hash: string, fee: bigint }>}
 */
export async function signP2pkhTransaction({ inputs, outputs }) {
  const template = importWalletTemplate(walletTemplateP2pkhNonHd);
  if (typeof template === 'string') throw new Error(`template import failed: ${template}`);
  const compiler = walletTemplateToCompilerBCH(template);

  // 2. Build signed-input objects — each references the private key for that input's address
  const signedInputs = inputs.map((input) => {
    const privateKey = deriveChildPrivKey(input.hdNode, input.account ?? 0, input.change ?? 0, input.index ?? 0);
    // Electrum `listunspent` returns `value`; libauth wants `valueSatoshis`. Accept either.
    const valueSats = BigInt(input.valueSatoshis ?? input.value);
    // Critical: pass the token prefix for token-bearing inputs. Without this, the
    // signing serialization preimage omits outputTokenPrefix and the signature fails
    // to validate on a CashTokens-aware tx (network rejects with
    // "mandatory-script-verify-flag-failed" because the preimage the signer saw
    // differs from the preimage the network verifies against).
    const tokenPrefix = utxoToTokenPrefix(input);
    return {
      outpointTransactionHash: hexToBin(input.tx_hash),
      outpointIndex: input.tx_pos,
      sequenceNumber: 0,
      unlockingBytecode: {
        compiler,
        script: 'unlock',
        valueSatoshis: valueSats,
        ...(tokenPrefix ? { token: tokenPrefix } : {}),
        data: {
          keys: {
            privateKeys: { key: privateKey },
          },
        },
      },
    };
  });

  // 3. Build output objects
  const libauthOutputs = outputs.map(outputToLibauth);

  // 4. Compile the transaction
  const generated = generateTransaction({
    inputs: signedInputs,
    outputs: libauthOutputs,
    locktime: 0,
    version: 2,
  });
  if (generated.success === false) {
    throw new Error(`transaction generation failed: ${JSON.stringify(generated)}`);
  }

  const txBytes = encodeTransaction(generated.transaction);
  const tx_hex = binToHex(txBytes);

  // Compute fee = inputs - outputs. Accept either `value` (Electrum) or `valueSatoshis` (libauth).
  const inputTotal = inputs.reduce((acc, i) => acc + BigInt(i.valueSatoshis ?? i.value), 0n);
  const outputTotal = outputs.reduce((acc, o) => acc + BigInt(o.valueSatoshis ?? o.value), 0n);
  const fee = inputTotal - outputTotal;

  // txid = sha256(sha256(txBytes)), displayed little-endian
  const { sha256 } = await import('@bitauth/libauth');
  const inner = sha256.hash(sha256.hash(txBytes));
  const tx_hash = Buffer.from(inner).reverse().toString('hex');

  return { tx_hex, tx_hash, fee };
}

function hexToBin(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) {
    throw new Error(`bad hex: ${hex}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}