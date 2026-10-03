// lib/wallet.mjs — wallet primitive (BIP39 mnemonic + HD derivation + cashaddr)
//
// Why libauth v3 primitives here (verified against the installed types in
// node_modules/@bitauth/libauth/build/lib/):
//   - generateBip39Mnemonic() -> string
//   - deriveSeedFromBip39Mnemonic(mnemonic, { passphrase }) -> Uint8Array
//   - deriveHdPrivateNodeFromSeed(seed, { assumeValidity: true }) -> HdPrivateNodeValid
//   - deriveHdPrivateNodeChild(node, { index, hardened }) -> HdPrivateNodeValid
//   - secp256k1 (default singleton from default-crypto-instances) -> Secp256k1
//       .derivePublicKeyCompressed(privateKey) -> Uint8Array
//       .signMessageHashSchnorr(privateKey, hash) -> Uint8Array
//   - hash160(payload) -> Uint8Array (RIPEMD160(SHA256(payload)))
//   - encodeCashAddress({ payload, prefix, type: CashAddressType.p2pkh }) -> string
//
// Pattern verified against Selene Wallet KeyManagerService.ts
// (https://gitlab.com/selene.cash/selene-wallet/-/blob/main/src/kernel/wallet/KeyManagerService.ts).

import {
  generateBip39Mnemonic,
  deriveSeedFromBip39Mnemonic,
  deriveHdPrivateNodeFromSeed,
  deriveHdPrivateNodeChild,
  secp256k1,
  hash160,
  encodeCashAddress,
  CashAddressType,
} from '@bitauth/libauth';
import { writeFileSync, readFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  decryptObject,
  isEncrypted,
  isPlaintext,
  encryptPlaintextWallet,
} from './wallet-encryption.mjs'

/**
 * The single source of truth for where the wallet lives.
 *
 * Every consumer MUST call this rather than recomputing the path. The paths
 * used to be derived independently in lib/wallet.mjs and in
 * scripts/encrypt-wallet.mjs, from the same expression. They agreed, and that
 * is exactly the problem: if they ever diverged, encrypt-wallet would rewrite a
 * different file than the CLI reads, and the wallet would appear to have lost
 * its funds. A path computed twice is a coin flip.
 *
 * Resolved at call time rather than captured at module load, so a caller that
 * sets BCH_WALLET_DIR after importing this module still gets the right answer.
 * The modules that used to capture it at import time (lib/wallet.mjs) now call
 * this instead.
 */
export function resolveWalletPaths(env = process.env) {
  const dir = env.BCH_WALLET_DIR || join(env.HOME || '/root', '.bch-wallet');
  return {
    dir,
    wallet: join(dir, 'wallet.json'),
    state: join(dir, 'state.json'),
  };
}

const WALLET_PATHS = resolveWalletPaths();
const WALLET_DIR = WALLET_PATHS.dir;
const WALLET_FILE = WALLET_PATHS.wallet;
const STATE_FILE = WALLET_PATHS.state;

// BIP44: m/44'/145'/account'/change/index  — 145 is BCH coin type (SLIP-0044)
export const BCH_COIN_TYPE = 145;
export const DEFAULT_ACCOUNT = 0;

/**
 * Create a new wallet. Saves to wallet.json — plaintext (v1) or encrypted (v2)
 * depending on whether BCH_WALLET_PASSPHRASE is set.
 *
 * SECURITY: addresses the finding in
 *   /home/luke/.openclaw/workspace/memory-bch-wiki/security/wallet-threat-model.md
 *   §3 — "wallet.json ships plaintext mnemonic + passphrase; passphrase persistence
 *   destroys BIP-39's plausible-deniability property."
 *
 * If BCH_WALLET_PASSPHRASE is set, the wallet is encrypted at rest with
 * scrypt + aes-256-gcm. The passphrase is NEVER stored on disk — only the
 * KDF salt and cipher IV/auth tag. Forgetting the passphrase loses the wallet.
 */
export function createWallet({ network = 'chipnet', passphrase = '', walletPassphrase = process.env.BCH_WALLET_PASSPHRASE || '' } = {}) {
  if (!['mainnet', 'chipnet', 'testnet3', 'testnet4'].includes(network)) {
    throw new Error(`unknown network: ${network}`);
  }
  const mnemonic = generateBip39Mnemonic();
  const plaintext = {
    version: 1,
    network,
    created_at: new Date().toISOString(),
    mnemonic,
    passphrase, // BIP-39 passphrase, not the wallet-encryption passphrase
    coin_type: BCH_COIN_TYPE,
    account: DEFAULT_ACCOUNT,
  };
  mkdirSync(WALLET_DIR, { recursive: true });

  let walletData;
  if (walletPassphrase && walletPassphrase.length > 0) {
    // Encrypt with the wallet-encryption passphrase. Encrypted form has version: 2.
    walletData = encryptPlaintextWallet(plaintext, walletPassphrase);
    console.error('[wallet] encrypted at rest with scrypt + aes-256-gcm');
  } else {
    walletData = plaintext;
    console.error('[wallet] WARNING: plaintext storage (no BCH_WALLET_PASSPHRASE set)');
  }

  writeFileSync(WALLET_FILE, JSON.stringify(walletData, null, 2));
  chmodSync(WALLET_FILE, 0o600);
  if (!existsSync(STATE_FILE)) {
    writeFileSync(STATE_FILE, JSON.stringify({ address_index: 0, change_index: 0 }, null, 2));
    chmodSync(STATE_FILE, 0o600);
  }
  return { mnemonic, network, encrypted: !!walletPassphrase };
}

/**
 * Load existing wallet from disk. If the wallet is encrypted (v2), the caller
 * must supply a wallet passphrase via the `walletPassphrase` option OR via
 * BCH_WALLET_PASSPHRASE env var. If the wallet is plaintext (v1), it is loaded
 * as-is (legacy mode, will print a warning the first time).
 */
export function loadWallet({ walletPassphrase = process.env.BCH_WALLET_PASSPHRASE } = {}) {
  if (!existsSync(WALLET_FILE)) return null;
  const raw = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));

  if (isEncrypted(raw)) {
    if (!walletPassphrase || walletPassphrase.length === 0) {
      throw new Error('wallet is encrypted; set BCH_WALLET_PASSPHRASE to load it');
    }
    return decryptObject({ kdf: raw.kdf, cipher: raw.cipher }, walletPassphrase);
  }

  if (isPlaintext(raw)) {
    // One-time plaintext warning
    if (!loadWallet._warned) {
      console.error('[wallet] WARNING: wallet.json is plaintext (v1). Run `bch-bot encrypt-wallet` to upgrade to v2 encrypted format.');
      loadWallet._warned = true;
    }
    return raw;
  }

  throw new Error('wallet.json has unknown format (neither v1 plaintext nor v2 encrypted)');
}

export function loadState() {
  if (!existsSync(STATE_FILE)) return { address_index: 0, change_index: 0 };
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

/** Derive the seed + HD root from a loaded wallet. */
export function loadHdNode() {
  const w = loadWallet();
  if (!w) throw new Error('no wallet; run create-wallet.mjs first');
  const seed = deriveSeedFromBip39Mnemonic(w.mnemonic, { passphrase: w.passphrase || '' });
  const hdNode = deriveHdPrivateNodeFromSeed(seed, { assumeValidity: true });
  if (typeof hdNode === 'string') throw new Error(`HD derivation failed: ${hdNode}`);
  return { wallet: w, hdNode };
}

/** Derive child private key at BIP44 m/44'/145'/account'/change/index.
 *
 * libauth API: deriveHdPrivateNodeChild(node, index) takes a bare number,
 * where index >= 0x80000000 means hardened. We add 0x80000000 for hardened steps.
 */
export function deriveChildPrivKey(hdNode, account = 0, change = 0, index = 0) {
  const HARDENED = 0x80000000;
  const path = [
    44 + HARDENED,
    BCH_COIN_TYPE + HARDENED,
    account + HARDENED,
    change,
    index,
  ];
  let node = hdNode;
  for (const step of path) {
    const child = deriveHdPrivateNodeChild(node, step);
    if (typeof child === 'string') {
      throw new Error(`derivation failed at step ${step}: ${child}`);
    }
    node = child;
  }
  return node.privateKey;
}

/** Derive BCH cashaddr (P2PKH) at m/44'/145'/account'/change/index. */
export function deriveAddress(hdNode, { account = 0, change = 0, index = 0, network }) {
  const privateKey = deriveChildPrivKey(hdNode, account, change, index);
  const pubkeyResult = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof pubkeyResult === 'string') throw new Error(`pubkey derivation failed: ${pubkeyResult}`);
  const pubkeyHash = hash160(pubkeyResult);
  const prefix = network === 'mainnet' ? 'bitcoincash' : 'bchtest';
  const addressResult = encodeCashAddress({
    payload: pubkeyHash,
    prefix,
    type: CashAddressType.p2pkh,
  });
  // libauth returns either a string error or { address: string, payload: ... } success object
  if (typeof addressResult === 'string') {
    throw new Error(`address encoding failed: ${addressResult}`);
  }
  const address = addressResult.address;
  return { address, pubkeyHash, privateKey };
}

/** Generate a fresh receiving address (increments state). */
export function newReceivingAddress() {
  const { wallet, hdNode } = loadHdNode();
  const state = loadState();
  const result = deriveAddress(hdNode, {
    account: wallet.account || 0,
    change: 0,
    index: state.address_index,
    network: wallet.network,
  });
  state.address_index += 1;
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  chmodSync(STATE_FILE, 0o600);
  return { ...result, index: state.address_index - 1 };
}

/**
 * Generate a fresh change address (m/44'/145'/0'/1/i) and increment the counter.
 *
 * @param {boolean} [commit=true] - when false, derive the address WITHOUT
 *   persisting the increment. Callers that might not end up broadcasting should
 *   pass false and only commit once the transaction is accepted.
 *
 * Why this matters: a change address that is derived but never used is harmless,
 * but the counter should only advance for addresses that actually receive
 * something. Persisting on derivation meant ANY run that got as far as signing
 * consumed indices -- including runs the network then rejected. Measured
 * 2026-10-02: one swap that signed correctly and was rejected with "Missing
 * inputs" advanced change_index by 5, and five such runs pushed it from 40 to
 * 45. Each wasted address also widens the scan window every balance check has to
 * cover, which is how 855,311 sat on index 38 went missing from `balance`.
 *
 * The failure mode here is waste, not loss -- an address nothing pays is just
 * unused. But a wallet that mutates its own state on a failed transaction is a
 * wallet whose state you cannot reason about.
 */
export function newChangeAddress(commit = true) {
  const { wallet, hdNode } = loadHdNode();
  const state = loadState();
  const result = deriveAddress(hdNode, {
    account: wallet.account || 0,
    change: 1,
    index: state.change_index,
    network: wallet.network,
  });
  if (!commit) {
    // Derived but not reserved. The caller must call commitChangeAddress() if the
    // transaction is actually accepted.
    return { ...result, index: state.change_index, committed: false };
  }
  state.change_index += 1;
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  chmodSync(STATE_FILE, 0o600);
  return { ...result, index: state.change_index - 1, committed: true };
}

/**
 * How many addresses of a chain to scan, derived from the wallet's own state.
 *
 * A fixed window is wrong on both sides. A UTXO can exist at ANY index the
 * wallet has ever derived -- including change addresses well past any hardcoded
 * gap limit. Measured 2026-10-02: this wallet held 855,311 sat on change index
 * 38 while `balance` scanned 0..19 and reported 0.00803 BCH instead of
 * 0.01659311. The same blind spot silently crippled swap funding, which could
 * only see the low indices.
 *
 * The floor keeps an empty state file scanning something useful. The ceiling
 * matters independently: a corrupted or inflated counter must not be able to
 * trigger thousands of derivations and node queries on a small host.
 *
 * @param {'address_index'|'change_index'} stateKey
 * @param {object} [state] - loaded state, or undefined to read it
 * @returns {number} number of addresses to derive
 */
export function scanCount(stateKey, state) {
  const st = state ?? loadState();
  const used = Number(st?.[stateKey] ?? 0);
  if (!Number.isFinite(used) || used < 0) return SCAN_FLOOR;
  return Math.min(SCAN_CEILING, Math.max(SCAN_FLOOR, used + SCAN_FORWARD_WINDOW));
}

export const SCAN_FLOOR = 20;
export const SCAN_CEILING = 200;
export const SCAN_FORWARD_WINDOW = 5;

/**
 * Persist the change counter after a transaction was actually accepted.
 *
 * Advances the counter to at least `index + 1`, so several addresses derived
 * without committing are all covered. Idempotent: a counter already past the
 * requested index is left alone, so it is safe to call twice.
 *
 * @param {number} index - index of the change address that was used
 * @returns {number} the resulting change_index
 */
export function commitChangeAddress(index) {
  const state = loadState();
  if (typeof index === 'number' && index >= state.change_index) {
    state.change_index = index + 1;
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    chmodSync(STATE_FILE, 0o600);
  }
  return state.change_index;
}

/** Derive N change addresses without touching state (used for gap-limit scans). */
export function deriveChangeAddresses(count = 20) {
  const { wallet, hdNode } = loadHdNode();
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = deriveAddress(hdNode, {
      account: wallet.account || 0,
      change: 1,
      index: i,
      network: wallet.network,
    });
    out.push({ ...r, index: i });
  }
  return out;
}

/** Derive N receiving addresses without touching state (used for gap-limit scans). */
export function deriveReceivingAddresses(count = 20) {
  const { wallet, hdNode } = loadHdNode();
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = deriveAddress(hdNode, {
      account: wallet.account || 0,
      change: 0,
      index: i,
      network: wallet.network,
    });
    out.push({ ...r, index: i });
  }
  return out;
}

export function walletPaths() {
  return { wallet: WALLET_FILE, state: STATE_FILE, dir: WALLET_DIR };
}

/**
 * Map a wallet address back to its BIP44 path, or fail loudly.
 *
 * Every signer needs this, and every caller previously implemented it as
 * `findIndex(...)` with a `?: 0` fallback -- which is a silent wrong key. A
 * UTXO whose address sits beyond the gap-limit window resolves to index 0, and
 * the transaction is then signed with the key for /0/0. That either fails to
 * validate, or worse, spends against a different UTXO than the fee arithmetic
 * assumed. One caller passed the raw -1 through instead.
 *
 * The fix is not a better fallback but no fallback: an address we cannot
 * resolve is an error. `window` is the derivation range the caller actually
 * scanned, so the message can say whether the address is simply outside it --
 * which is a gap-limit problem the user can widen -- rather than "unknown key".
 */
export function resolveAddressPath(address, { window = 20, label = 'address' } = {}) {
  const recv = deriveReceivingAddresses(window);
  const recvIdx = recv.findIndex((a) => a.address === address);
  if (recvIdx >= 0) return { account: 0, change: 0, index: recvIdx };

  const chg = deriveChangeAddresses(window);
  const chgIdx = chg.findIndex((a) => a.address === address);
  if (chgIdx >= 0) return { account: 0, change: 1, index: chgIdx };

  throw new Error(
    `cannot resolve the key for ${label} ${address}: it is not in the first ${window} ` +
    `receiving addresses or the first ${window} change addresses. It is either from a ` +
    `different wallet, or beyond the gap limit this command scans -- widen the scan ` +
    `rather than guessing an index, because a wrong index signs with the wrong key.`
  );
}