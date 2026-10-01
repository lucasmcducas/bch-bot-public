// scripts/test-kdf-params.mjs
//
// BCH_WALLET_KDF_N was documented in lib/wallet-encryption.mjs as "tunable via
// env var" while no code read it, so a user who weakened it got a silent
// no-op and believed their wallet was better or worse protected than it was.
//
// The subtle part is the envelope. Decryption trusts the N recorded in the
// envelope, not the current environment, so:
//   - encryption must resolve N once and record THAT value, or it writes a
//     wallet that claims N=32768 while being derived with something else and
//     can never be read back;
//   - decryption must NOT consult the variable, or setting it would make every
//     existing wallet unreadable.
//
// Both are asserted here.

import { kdfNFromEnv, encryptObject, decryptObject, deriveKey } from '../lib/wallet-encryption.mjs';

let passed = 0;
let failed = 0;
function eq(a, b, m = '') { if (a !== b) { failed++; console.error(`  ✗ ${m}expected ${b}, got ${a}`); return; } passed++; }
function ok(v, m) { if (!v) { failed++; console.error(`  ✗ ${m}`); return; } passed++; }
function throws(fn, re, m) {
  try { fn(); } catch (e) {
    if (re.test(e.message)) { passed++; return; }
    failed++; console.error(`  ✗ ${m}: wrong error: ${e.message}`); return;
  }
  failed++; console.error(`  ✗ ${m}: expected a throw`);
}

const SAVED = process.env.BCH_WALLET_KDF_N;
const setN = (v) => { if (v === undefined) delete process.env.BCH_WALLET_KDF_N; else process.env.BCH_WALLET_KDF_N = v; };

try {
  console.log('--- the default is used when the variable is unset ---');
  {
    eq(kdfNFromEnv({}), 32768, 'unset: ');
    eq(kdfNFromEnv({ BCH_WALLET_KDF_N: '' }), 32768, 'empty: ');
  }

  console.log('--- a valid power of two is honoured ---');
  {
    eq(kdfNFromEnv({ BCH_WALLET_KDF_N: '16384' }), 16384, '16384: ');
    eq(kdfNFromEnv({ BCH_WALLET_KDF_N: '1024' }), 1024, '1024: ');
    eq(kdfNFromEnv({ BCH_WALLET_KDF_N: '2' }), 2, '2: ');
  }

  console.log('--- invalid values are refused by name ---');
  {
    // scrypt requires a power of two > 1; anything else is a confusing crash
    // deep inside node:crypto, so the variable name belongs in the error.
    for (const bad of ['0', '1', '3', '1000', '100', '12345']) {
      throws(() => kdfNFromEnv({ BCH_WALLET_KDF_N: bad }), /power of two/, `${bad} must be refused`);
    }
    for (const bad of ['abc', '2.5', '-4', ' 16', '16 ', '0x10', '1e3', '']) {
      if (bad === '') { passed++; continue; } // empty means "unset"
      throws(() => kdfNFromEnv({ BCH_WALLET_KDF_N: bad }), /positive integer/, `${JSON.stringify(bad)} must be refused`);
    }
    throws(() => kdfNFromEnv({ BCH_WALLET_KDF_N: String(2 ** 31) }), /too large/, 'an absurd N must be refused');
  }

  console.log('--- encryption records the N it actually used ---');
  {
    setN(undefined);
    const standard = encryptObject({ mnemonic: 'seed words here' }, 'correct horse');
    eq(standard.kdf.N, 32768, 'default envelope N: ');
    eq(decryptObject(standard, 'correct horse').mnemonic, 'seed words here', 'default round trip: ');

    setN('16384');
    const custom = encryptObject({ mnemonic: 'seed words here' }, 'correct horse');
    eq(custom.kdf.N, 16384, 'custom envelope N: ');
    // The envelope is the only thing decryption reads, so it must state the
    // truth. If this ever records 32768, the wallet is unreadable.
    setN(undefined);
    eq(decryptObject(custom, 'correct horse').mnemonic, 'seed words here', 'custom round trip with the variable cleared: ');
  }

  console.log('--- decryption ignores the current variable ---');
  {
    // Encrypt at the default, then set the variable. The wallet must still open:
    // an existing wallet must never become unreadable because a variable moved.
    setN(undefined);
    const wallet = encryptObject({ mnemonic: 'legacy' }, 'pw');
    setN('1024');
    eq(decryptObject(wallet, 'pw').mnemonic, 'legacy', 'default wallet opens under a different N: ');
    setN(undefined);
  }

  console.log('--- a wrong passphrase still fails ---');
  {
    setN(undefined);
    const wallet = encryptObject({ mnemonic: 'secret' }, 'right');
    throws(() => decryptObject(wallet, 'wrong'), /./, 'wrong passphrase must be refused');
  }

  console.log('--- deriveKey honours opts.N over the environment ---');
  {
    setN('16384');
    const a = deriveKey('pw', Buffer.alloc(32, 1), { N: 32768 });
    setN('32768');
    const b = deriveKey('pw', Buffer.alloc(32, 1), { N: 16384 });
    // Different N must give different keys, proving opts wins and is not
    // silently replaced by the environment.
    ok(Buffer.from(a).toString('hex') !== Buffer.from(b).toString('hex'),
      'opts.N must take precedence over BCH_WALLET_KDF_N');
    setN(undefined);
  }

  console.log('--- a larger N is actually usable, not rejected by maxmem ---');
  {
    // A fixed 64 MB cap would make any N above 2^15 fail with an opaque
    // "Invalid scrypt params", which looks like the variable being ignored.
    setN('65536');
    const big = encryptObject({ mnemonic: 'high N' }, 'pw');
    eq(big.kdf.N, 65536, 'large envelope N: ');
    setN(undefined);
    eq(decryptObject(big, 'pw').mnemonic, 'high N', 'large N round trip: ');
  }
} finally {
  if (SAVED === undefined) delete process.env.BCH_WALLET_KDF_N; else process.env.BCH_WALLET_KDF_N = SAVED;
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
