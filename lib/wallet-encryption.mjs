// lib/wallet-encryption.mjs — wallet at-rest encryption (aes-256-gcm + scrypt)
//
// Addresses the security finding in references/security KB:
// security/wallet-threat-model.md §3 — "wallet.json ships plaintext
// mnemonic + passphrase; passphrase persistence destroys BIP-39's
// plausible-deniability property."
//
// Format on disk:
//   {
//     version: 2,
//     network: "mainnet",
//     created_at: "2026-09-19T...",
//     kdf: { name: "scrypt", N: 32768, r: 8, p: 1, salt: <hex> },
//     cipher: { name: "aes-256-gcm", iv: <hex>, tag: <hex>, ciphertext: <hex> },
//     cipher_payment: { ... same fields but encrypts payment JSON ... },
//     hint: "<optional plaintext hint, e.g. 'passwords are 14+ chars'>"
//   }
//
// The wallet's mnemonic is encrypted with a passphrase-derived key. The
// passphrase is *not* stored anywhere — only its scrypt salt + the derived
// key's iv + auth tag. If the user forgets the passphrase, the wallet is
// unrecoverable (no backdoor).
//
// IMPORTANT: this module handles encryption only. The wallet is loaded
// and used through the same lib/wallet.mjs API (loadWallet, loadHdNode,
// etc.) which call decryptWallet() under the hood.

import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from 'node:crypto';

/** Scrypt parameters — N=32768 is the Node.js default for scrypt(password, salt, 64).
 * N=2^15 takes ~100ms on modern hardware. Tunable via env var BCH_WALLET_KDF_N.
 */
const DEFAULT_KDF_PARAMS = {
  name: 'scrypt',
  N: 32768,
  r: 8,
  p: 1,
  saltBytes: 32,
};

const CIPHER_NAME = 'aes-256-gcm';
const KEY_BYTES = 32; // aes-256
const IV_BYTES = 12; // gcm nonce

/**
 * Derive a 32-byte key from a passphrase using scrypt.
 *
 * @param {string} passphrase
 * @param {Buffer} salt
 * @param {object} [opts]
 * @returns {Buffer} 32-byte key
 */
export function deriveKey(passphrase, salt, opts = {}) {
  const N = opts.N ?? DEFAULT_KDF_PARAMS.N;
  const r = opts.r ?? DEFAULT_KDF_PARAMS.r;
  const p = opts.p ?? DEFAULT_KDF_PARAMS.p;
  if (!passphrase || passphrase.length === 0) {
    throw new Error('passphrase required for wallet encryption');
  }
  // maxmem: 64 MB (covers N=2^15 comfortably; bump if N is higher)
  return scryptSync(passphrase, salt, KEY_BYTES, { N, r, p, maxmem: 64 * 1024 * 1024 });
}

/**
 * Encrypt a JSON-serializable object with a passphrase.
 *
 * @param {object} plaintext — any JSON-serializable object
 * @param {string} passphrase
 * @returns {object} — encrypted envelope (the on-disk format)
 */
export function encryptObject(plaintext, passphrase) {
  if (!passphrase || passphrase.length === 0) {
    throw new Error('passphrase required to encrypt wallet');
  }
  const salt = randomBytes(DEFAULT_KDF_PARAMS.saltBytes);
  const key = deriveKey(passphrase, salt);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER_NAME, key, iv);
  const plaintextBytes = Buffer.from(JSON.stringify(plaintext), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    kdf: {
      name: DEFAULT_KDF_PARAMS.name,
      N: DEFAULT_KDF_PARAMS.N,
      r: DEFAULT_KDF_PARAMS.r,
      p: DEFAULT_KDF_PARAMS.p,
      salt: salt.toString('hex'),
    },
    cipher: {
      name: CIPHER_NAME,
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      ciphertext: ciphertext.toString('hex'),
    },
  };
}

/**
 * Decrypt an envelope produced by encryptObject.
 *
 * @param {object} envelope — the on-disk format
 * @param {string} passphrase
 * @returns {object} — decrypted plaintext
 * @throws if passphrase is wrong (auth tag mismatch) or envelope is malformed
 */
export function decryptObject(envelope, passphrase) {
  if (!envelope || envelope.kdf?.name !== 'scrypt' || envelope.cipher?.name !== CIPHER_NAME) {
    throw new Error('envelope is not in expected scrypt + aes-256-gcm format');
  }
  const salt = Buffer.from(envelope.kdf.salt, 'hex');
  const iv = Buffer.from(envelope.cipher.iv, 'hex');
  const tag = Buffer.from(envelope.cipher.tag, 'hex');
  const ciphertext = Buffer.from(envelope.cipher.ciphertext, 'hex');
  const key = deriveKey(passphrase, salt, {
    N: envelope.kdf.N,
    r: envelope.kdf.r,
    p: envelope.kdf.p,
  });
  const decipher = createDecipheriv(CIPHER_NAME, key, iv);
  decipher.setAuthTag(tag);
  let plaintextBytes;
  try {
    plaintextBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    // aes-256-gcm throws on auth tag mismatch (i.e., wrong passphrase)
    throw new Error('decryption failed: wrong passphrase or corrupted wallet');
  }
  return JSON.parse(plaintextBytes.toString('utf8'));
}

/**
 * Detect whether a wallet.json content is encrypted (v2 format) or plaintext (v1 format).
 *
 * @param {object} wallet
 * @returns {boolean}
 */
export function isEncrypted(wallet) {
  return !!(wallet?.version === 2 && wallet?.cipher && wallet?.kdf);
}

/**
 * Detect whether a wallet.json content is plaintext (v1 format).
 *
 * @param {object} wallet
 * @returns {boolean}
 */
export function isPlaintext(wallet) {
  return !!(wallet?.version === 1 && typeof wallet?.mnemonic === 'string');
}

/**
 * Encrypt an existing plaintext wallet.json content into the v2 encrypted format.
 *
 * @param {object} plaintextWallet — wallet.json content (v1 format)
 * @param {string} passphrase
 * @returns {object} — v2 encrypted envelope
 */
export function encryptPlaintextWallet(plaintextWallet, passphrase) {
  if (!isPlaintext(plaintextWallet)) {
    throw new Error('not a v1 plaintext wallet; refusing to encrypt');
  }
  const inner = encryptObject(plaintextWallet, passphrase);
  return {
    version: 2,
    network: plaintextWallet.network,
    created_at: plaintextWallet.created_at,
    ...inner,
  };
}

/**
 * Decrypt an encrypted wallet back to plaintext form (for re-encryption with
 * a new passphrase, or for migration).
 *
 * @param {object} encryptedWallet
 * @param {string} passphrase
 * @returns {object} — plaintext wallet (v1 shape)
 */
export function decryptEncryptedWallet(encryptedWallet, passphrase) {
  if (!isEncrypted(encryptedWallet)) {
    throw new Error('not a v2 encrypted wallet; refusing to decrypt');
  }
  return decryptObject(
    { kdf: encryptedWallet.kdf, cipher: encryptedWallet.cipher },
    passphrase,
  );
}

// Re-export some helpers for tests
export const __test = {
  timingSafeEqual,
  CIPHER_NAME,
  KEY_BYTES,
  IV_BYTES,
};
