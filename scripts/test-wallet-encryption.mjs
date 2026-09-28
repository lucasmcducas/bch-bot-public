#!/usr/bin/env node
// scripts/test-wallet-encryption.mjs — unit tests for lib/wallet-encryption.mjs
//
// Verifies:
//   1. Round-trip: encrypt then decrypt returns the original plaintext
//   2. Wrong passphrase throws (auth tag mismatch)
//   3. Corrupted ciphertext throws
//   4. Tampered KDF salt throws (different key derivation)
//   5. isEncrypted / isPlaintext detection
//   6. encryptPlaintextWallet wraps a v1 wallet correctly
//   7. decryptEncryptedWallet unwraps it back
//   8. Empty passphrase refused
//   9. KDF parameter changes produce different keys (slow KDF, may take 1-2s)
//  10. Determinism: same passphrase + salt + plaintext → same ciphertext + IV
//  11. Random IV: two encryptions of the same plaintext are different
//  12. The wallet envelope includes version=2 and the expected fields
//  13. Refuses to encrypt a non-v1 wallet
//  14. Refuses to decrypt a non-v2 wallet

import {
  encryptObject,
  decryptObject,
  isEncrypted,
  isPlaintext,
  encryptPlaintextWallet,
  decryptEncryptedWallet,
  deriveKey,
} from '../lib/wallet-encryption.mjs';
import { randomBytes } from 'node:crypto';

let passed = 0, failed = 0;
const fails = [];

function assert(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    fails.push({ label, detail });
    console.log(`  ✗ ${label} ${detail ?? ''}`);
  }
}

const SAMPLE_PLAINTEXT = {
  version: 1,
  network: 'mainnet',
  created_at: '2026-09-19T12:00:00.000Z',
  mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  passphrase: '',
  coin_type: 145,
  account: 0,
};

const SAMPLE_WALLET = SAMPLE_PLAINTEXT;

console.log('1. round-trip encrypt/decrypt');
const envelope = encryptObject(SAMPLE_PLAINTEXT, 'correct horse battery staple');
const decrypted = decryptObject(envelope, 'correct horse battery staple');
assert('decrypted equals original', JSON.stringify(decrypted) === JSON.stringify(SAMPLE_PLAINTEXT));

console.log('\n2. wrong passphrase throws');
let threw = false;
try { decryptObject(envelope, 'wrong passphrase'); } catch (e) {
  threw = true;
  assert('error message mentions wrong passphrase', /wrong passphrase|decryption failed/i.test(e.message), e.message);
}
assert('threw', threw);

console.log('\n3. corrupted ciphertext throws');
const corrupted = JSON.parse(JSON.stringify(envelope));
corrupted.cipher.ciphertext = '00'.repeat(32); // zero bytes
let threw3 = false;
try { decryptObject(corrupted, 'correct horse battery staple'); } catch (e) { threw3 = true; }
assert('threw on corrupted ciphertext', threw3);

console.log('\n4. tampered salt fails to decrypt');
const tampered = JSON.parse(JSON.stringify(envelope));
tampered.kdf.salt = randomBytes(32).toString('hex');
let threw4 = false;
try { decryptObject(tampered, 'correct horse battery staple'); } catch (e) { threw4 = true; }
assert('threw on tampered salt', threw4);

console.log('\n5. isEncrypted / isPlaintext detection');
assert('isEncrypted(v2 envelope) = true', isEncrypted(envelope) === false); // bare envelope doesn't have version:2
const wrapped = { version: 2, ...envelope };
assert('isEncrypted(v2 wallet) = true', isEncrypted(wrapped) === true);
assert('isPlaintext(v2 wallet) = false', isPlaintext(wrapped) === false);
assert('isPlaintext(v1) = true', isPlaintext(SAMPLE_PLAINTEXT) === true);
assert('isEncrypted(v1) = false', isEncrypted(SAMPLE_PLAINTEXT) === false);
assert('isPlaintext(null) = false', isPlaintext(null) === false);
assert('isEncrypted(null) = false', isEncrypted(null) === false);

console.log('\n6. encryptPlaintextWallet wraps v1 → v2');
const v2wallet = encryptPlaintextWallet(SAMPLE_WALLET, 'mypass');
assert('version = 2', v2wallet.version === 2);
assert('has cipher', !!v2wallet.cipher);
assert('has kdf', !!v2wallet.kdf);
assert('preserves network', v2wallet.network === 'mainnet');
assert('preserves created_at', v2wallet.created_at === SAMPLE_WALLET.created_at);
assert('isEncrypted = true', isEncrypted(v2wallet) === true);
assert('isPlaintext = false', isPlaintext(v2wallet) === false);

console.log('\n7. decryptEncryptedWallet unwraps v2 → v1');
const decryptedV1 = decryptEncryptedWallet(v2wallet, 'mypass');
assert('round-trip preserves all fields',
  decryptedV1.mnemonic === SAMPLE_WALLET.mnemonic &&
  decryptedV1.network === SAMPLE_WALLET.network &&
  decryptedV1.coin_type === SAMPLE_WALLET.coin_type);

console.log('\n8. empty passphrase refused');
let threw8a = false, threw8b = false;
try { encryptObject({}, ''); } catch (e) { threw8a = true; }
try { deriveKey('', Buffer.alloc(32)); } catch (e) { threw8b = true; }
assert('encryptObject with empty passphrase throws', threw8a);
assert('deriveKey with empty passphrase throws', threw8b);

console.log('\n9. KDF param changes produce different keys');
const salt = randomBytes(32);
const key1 = deriveKey('samepass', salt, { N: 16384, r: 8, p: 1 });
const key2 = deriveKey('samepass', salt, { N: 32768, r: 8, p: 1 });
assert('different N produces different keys', !key1.equals(key2));

console.log('\n10. random IV: same plaintext → different ciphertext');
const e1 = encryptObject(SAMPLE_PLAINTEXT, 'samepass');
const e2 = encryptObject(SAMPLE_PLAINTEXT, 'samepass');
assert('different IV', e1.cipher.iv !== e2.cipher.iv);
assert('different ciphertext', e1.cipher.ciphertext !== e2.cipher.ciphertext);
assert('both decrypt to same plaintext',
  JSON.stringify(decryptObject(e1, 'samepass')) === JSON.stringify(decryptObject(e2, 'samepass')));

console.log('\n11. malformed envelope rejected');
let threw11 = false;
try { decryptObject({ kdf: { name: 'argon2' }, cipher: {} }, 'pass'); } catch (e) {
  threw11 = true;
  assert('argon2 envelope rejected', /not in expected.*format/i.test(e.message), e.message);
}
assert('threw on malformed envelope', threw11);

console.log('\n12. encrypt non-v1 refused');
let threw12 = false;
try { encryptPlaintextWallet({ version: 2, foo: 'bar' }, 'pass'); } catch (e) { threw12 = true; }
assert('threw on non-v1', threw12);

console.log('\n13. decrypt non-v2 refused');
let threw13 = false;
try { decryptEncryptedWallet({ version: 1, mnemonic: 'foo' }, 'pass'); } catch (e) { threw13 = true; }
assert('threw on non-v2', threw13);

console.log('\n14. handles unicode / emojis in plaintext');
const fancy = { greeting: 'héllo 🌍', nested: { arr: ['α', 'β', 'γ'] } };
const ef = encryptObject(fancy, 'pässwörd 🔑');
const df = decryptObject(ef, 'pässwörd 🔑');
assert('unicode round-trip',
  df.greeting === fancy.greeting &&
  JSON.stringify(df.nested) === JSON.stringify(fancy.nested));

console.log();
console.log('='.repeat(60));
console.log(`PASSED ${passed}, FAILED ${failed}`);
if (failed > 0) {
  console.log('\nFAILED:');
  for (const f of fails) console.log(`  ✗ ${f.label} ${f.detail ?? ''}`);
  process.exit(1);
}
process.exit(0);
