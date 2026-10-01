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

// Build the index-aligned prevout list libauth needs for the utxos sighash
// flag.
//
// The flag makes the preimage commit to the previous output of EVERY input, not
// just the one being signed, so this list must be complete and correct or the
// signature will not validate. The router returns `source_outputs` for exactly
// this purpose. When they are missing we fail rather than substitute
// placeholders: a preimage built from invented prevouts yields a signature the
// network rejects, and a silent wrong answer here is worse than a clear error.
function buildSourceOutputs(decoded, inputsToSign, routerPrevouts) {
  if (!Array.isArray(routerPrevouts) || routerPrevouts.length < decoded.inputs.length) {
    throw new Error(
      "source_outputs are required to sign a router-built transaction: the utxos " +
      "sighash flag commits to every input's previous output, so a partial or " +
      "missing prevout list would produce an invalid signature"
    );
  }
  return decoded.inputs.map((_, i) => {
    const prevout = routerPrevouts[i];
    if (!prevout || !prevout.lockingScriptHex) {
      throw new Error(`source_outputs is missing the locking script for input ${i}`);
    }
    return {
      lockingBytecode: hexToBin(prevout.lockingScriptHex),
      valueSatoshis: BigInt(prevout.value),
    };
  });
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

// Sign a transaction someone else assembled, touching only the inputs we own.
//
// A Cauldron swap arrives from the router as a complete unsigned transaction:
// our own funding inputs alongside the DEX's pool inputs, which the operator has
// already signed (that signing IS the service being paid for). So we must not
// re-sign or rewrite those bytes -- we only fill in the scriptSigs for the
// indices the router named in `inputsToSign`.
//
// libauth's generateTransaction builds a whole transaction from scratch and
// cannot partially sign one, so this uses the lower-level path the CashTokens
// work already established: decode -> per-input signing serialization ->
// Schnorr sign -> splice the signature in -> re-encode. Everything outside the
// targeted scriptSigs is carried through byte-for-byte by decode/encode.

export async function signExternalTransaction({
  unsignedTxHex,
  inputsToSign,
  // (index) => { privateKey, valueSatoshis, tokenPrefix?, lockingScriptHex? }
  inputMaterial,
  // Router-supplied prevouts, index-aligned to ALL inputs (not just ours).
  // Only the entries for inputsToSign are used.
  sourceOutputs = null,
}) {
  if (typeof unsignedTxHex !== 'string' || unsignedTxHex.length === 0) {
    throw new Error('unsignedTxHex is required');
  }
  if (!Array.isArray(inputsToSign) || inputsToSign.length === 0) {
    throw new Error('inputsToSign must be a non-empty array of input indices');
  }
  if (typeof inputMaterial !== 'function') {
    throw new Error('inputMaterial(index) must return the key and value for that input');
  }

  const { decodeTransactionBCH, encodeTransaction, generateSigningSerializationBCH,
    SigningSerializationTypeBCH, SigningSerializationFlag, secp256k1, sha256, hash256 } =
    await import('@bitauth/libauth');

  const bytes = hexToBin(unsignedTxHex);
  const decoded = decodeTransactionBCH(bytes);
  if (!decoded || !decoded.inputs) {
    throw new Error('could not decode the transaction returned by the router');
  }

  // The utxos flag makes the preimage commit to the previous output of EVERY
  // input, so source_outputs must be complete and correct or the signature
  // will not validate. Built once and reused for each input.
  const prevouts = buildSourceOutputs(decoded, inputsToSign, sourceOutputs);

  for (const index of inputsToSign) {
    const input = decoded.inputs[index];
    if (!input) throw new Error(`inputsToSign references input ${index}, which does not exist`);

    const material = inputMaterial(index);
    if (!material || !material.privateKey) {
      throw new Error(`no signing key available for input ${index}`);
    }
    if (material.valueSatoshis === undefined) {
      throw new Error(`no value supplied for input ${index} (required for the sighash preimage)`);
    }

    // Both of these go into the preimage as RAW BYTES, not numbers:
    // libauth flattens the preimage with a reducer that reads `.length` off
    // every element, so a plain number throws "offset is out of bounds". A
    // single-element Uint8Array is the byte-encoded form consensus expects.
    //
    // The value is forkId (0x40) plus utxos (0x20) when the input carries a
    // CashToken, plus the allOutputs mode selector (0x01) = 0x41 for plain BCH
    // and 0x61 for a token input. A CashTokens input signed without the utxos
    // bit is rejected by the network with mandatory-script-verify-flag-failed.
    const utxosBit = material.tokenPrefix ? SigningSerializationFlag.utxos : 0;
    const sighashValue =
      SigningSerializationFlag.forkId | utxosBit | SigningSerializationTypeBCH.allOutputs;
    const signingSerializationType = new Uint8Array([sighashValue]);

    // For a P2PKH spend the "corresponding output" is the locking script the
    // signature commits to, and libauth only supplies one when the input index
    // happens to land inside the output list. A router swap has more inputs
    // than outputs, so it comes back undefined -- and because the preimage is
    // assembled with a reducer that reads `.length` off every element, an
    // undefined there is dropped rather than reported, producing a preimage
    // that no verifier will accept. Supplying it explicitly is what puts the
    // pubkey hash into the digest the network will recompute.
    const coveredBytecode = prevouts[index].lockingBytecode;
    const correspondingOutput = {
      lockingBytecode: coveredBytecode,
      valueSatoshis: BigInt(material.valueSatoshis),
    };

    // libauth resolves the outpoint from context.transaction.inputs at
    // `inputIndex`, so the transaction passed here must be the WHOLE decoded
    // transaction and the index must point at the real position. Handing it a
    // single-element array of just this input makes the lookup fail.
    const serialization = generateSigningSerializationBCH(
      {
        transaction: {
          version: decoded.version,
          locktime: decoded.locktime,
          inputs: decoded.inputs,
          outputs: decoded.outputs,
        },
        sourceOutputs: prevouts,
        inputIndex: index,
        input: {
          outpointTransactionHash: input.outpointTransactionHash,
          outpointIndex: input.outpointIndex,
          sequenceNumber: input.sequenceNumber,
          valueSatoshis: BigInt(material.valueSatoshis),
          ...(material.tokenPrefix ? { token: material.tokenPrefix } : {}),
        },
        // Returned by the components builder when inputIndex falls inside the
        // output list; supplying it keeps the preimage identical either way.
        correspondingOutput,
      },
      { coveredBytecode, signingSerializationType }
    );
    if (typeof serialization === 'string') {
      throw new Error(`signing serialization failed for input ${index}: ${serialization}`);
    }

    // The signing serialization is the PREIMAGE, not the digest: libauth wants
    // a 32-byte message hash, so it has to be double-SHA256'd first. Passing
    // the raw serialization makes libauth try to pad a long buffer into a
    // 32-byte slot and throw "offset is out of bounds". This is the same
    // SHA256d step cashscript.mjs::computeCovenantSighash performs.
    //
    // Argument order is (privateKey, messageHash).
    const digest = hash256(serialization);
    const signature = secp256k1.signMessageHashSchnorr(material.privateKey, digest);
    if (typeof signature === 'string') {
      throw new Error(`Schnorr signing failed for input ${index}: ${signature}`);
    }
    // Schnorr signatures are 64 raw bytes; BCH carries them with a trailing
    // sighash byte, the same value used in the preimage.
    const sigWithFlag = new Uint8Array(65);
    sigWithFlag.set(signature, 0);
    sigWithFlag[64] = sighashValue;

    const pubkey = secp256k1.derivePublicKeyCompressed(material.privateKey);

    // A decoded transaction carries each unlocking bytecode as raw bytes, so
    // the P2PKH scriptSig is assembled by hand rather than run through the
    // compiler: <sig+flag> <pubkey>, each length-prefixed.
    const scriptSig = new Uint8Array(1 + 65 + 1 + pubkey.length);
    let at = 0;
    scriptSig[at++] = 65;
    scriptSig.set(sigWithFlag, at);
    at += 65;
    scriptSig[at++] = pubkey.length;
    scriptSig.set(pubkey, at);
    input.unlockingBytecode = scriptSig;
  }
  const signedBytes = encodeTransaction(decoded);
  const txid = Buffer.from(sha256.hash(sha256.hash(signedBytes))).reverse().toString('hex');
  return { txHex: binToHex(signedBytes), txid };
}
