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

/** Scrypt parameters. N=32768 (2^15) takes ~100ms on modern hardware.
 *
 * BCH_WALLET_KDF_N was documented as tunable here for a long time while no code
 * ever read it, so a user who weakened it to make decryption faster got a
 * silent no-op and believed their wallet was less protected than it was. It is
 * now honoured, and validated: scrypt requires N to be a power of two greater
 * than 1, and an arbitrary value would otherwise be a confusing crash deep
 * inside node:crypto. It also applies only to ENCRYPTION. Decryption must use
 * the parameters recorded in the envelope, or an old wallet would become
 * unreadable the moment the variable was set.
 */
const DEFAULT_KDF_PARAMS = {
  name: 'scrypt',
  N: 32768,
  r: 8,
  p: 1,
  saltBytes: 32,
};

// scrypt requires N to be a power of two greater than 1. Enforce it here so the
// error names the variable rather than surfacing as a crypto-layer message.
export function kdfNFromEnv(env = process.env) {
  const raw = env.BCH_WALLET_KDF_N;
  if (raw === undefined || raw === '') return DEFAULT_KDF_PARAMS.N;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`BCH_WALLET_KDF_N must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  const n = Number(raw);
  // Power of two, > 1. scrypt also requires N < 2^(128*r/8); with r=8 that is
  // 2^32, and anything above it will exhaust maxmem regardless.
  if (n <= 1 || (n & (n - 1)) !== 0) {
    throw new Error(`BCH_WALLET_KDF_N must be a power of two greater than 1, got ${n}`);
  }
  if (n > 2 ** 30) {
    throw new Error(`BCH_WALLET_KDF_N=${n} is too large; raise maxmem in deriveKey or lower N`);
  }
  return n;
}

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
  const N = opts.N ?? kdfNFromEnv();
  const r = opts.r ?? DEFAULT_KDF_PARAMS.r;
  const p = opts.p ?? DEFAULT_KDF_PARAMS.p;
  if (!passphrase || passphrase.length === 0) {
    throw new Error('passphrase required for wallet encryption');
  }
  // scrypt memory is about 128 * N * r bytes, so maxmem has to scale with N.
  // A fixed 64 MB cap works for N=2^15 but makes every larger value fail with an
  // opaque "Invalid scrypt params" from node:crypto, which would look like the
  // variable was still being ignored. Give it headroom over the requirement.
  const required = 128 * N * r;
  const maxmem = Math.max(64 * 1024 * 1024, required * 2);
  return scryptSync(passphrase, salt, KEY_BYTES, { N, r, p, maxmem });
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
  // Resolve N ONCE and use it for both the key derivation and the envelope.
  // Reading the env var inside deriveKey but recording the constant here would
  // write a wallet claiming N=32768 that was actually derived with something
  // else -- and it would then be unreadable, because decryption trusts the
  // recorded value. The envelope is the only thing a future version reads, so
  // it must state the truth.
  const N = kdfNFromEnv();
  const salt = randomBytes(DEFAULT_KDF_PARAMS.saltBytes);
  const key = deriveKey(passphrase, salt, { N });
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER_NAME, key, iv);
  const plaintextBytes = Buffer.from(JSON.stringify(plaintext), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    kdf: {
      name: DEFAULT_KDF_PARAMS.name,
      N,
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
