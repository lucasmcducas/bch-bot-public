// scripts/test-wallet.mjs
//
// lib/wallet.mjs had zero tests, and it is the one file where a silent
// off-by-one sends real money: deriveChildPrivKey builds the BIP44 path, and
// resolveAddressPath maps an address back to it. Both are exercised here
// against a throwaway wallet in a temp directory -- no real seed, no network.
//
// The headline rule is that an unresolvable address is an ERROR. The four
// scripts that used to implement this with `findIndex(...) ? 0` were signing
// with the key for /0/0, and one passed a raw -1 through.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
let failed = 0;
function eq(a, b, m = '') { if (a !== b) { failed++; throw new Error(`${m}expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); } passed++; }
function ok(v, m) { if (!v) { failed++; throw new Error(m); } passed++; }
function throws(fn, re, m) {
  try { fn(); } catch (e) {
    if (re.test(e.message)) { passed++; return e; }
    failed++; throw new Error(`${m}: wrong error: ${e.message}`);
  }
  failed++; throw new Error(`${m}: expected a throw`);
}

const dir = mkdtempSync(join(tmpdir(), 'wallet-test-'));
const oldDir = process.env.BCH_WALLET_DIR;
process.env.BCH_WALLET_DIR = dir;
mkdirSync(dir, { recursive: true });

try {
  // A fixed, well-known test seed. Public knowledge, zero value, used only so
  // the expected addresses below are stable. The seed and HD node come from the
  // same libauth helpers the wallet itself uses, so the test exercises the
  // production derivation path rather than a parallel implementation of it.
  const { deriveSeedFromBip39Mnemonic, deriveHdPrivateNodeFromSeed, deriveHdPrivateNodeChild } =
    await import('@bitauth/libauth');
  const { createWallet, loadWallet, loadHdNode, deriveChildPrivKey, deriveAddress,
          deriveReceivingAddresses, deriveChangeAddresses, resolveAddressPath,
          newReceivingAddress, newChangeAddress, walletPaths, resolveWalletPaths } = await import('../lib/wallet.mjs');

  const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const seed = deriveSeedFromBip39Mnemonic(MNEMONIC, { passphrase: '' });

  // Write a v1 plaintext wallet so the derivation is deterministic.
  const walletFile = join(dir, 'wallet.json');
  writeFileSync(walletFile, JSON.stringify({
    version: 1, network: 'mainnet', account: 0, mnemonic: MNEMONIC, addressCounter: 0, changeCounter: 0,
  }, null, 2));
  chmodSync(walletFile, 0o600);

  const hdNode = deriveHdPrivateNodeFromSeed(seed, { assumeValidity: true });

  console.log('--- derivation is deterministic and network-correct ---');
  {
    const { hdNode: loaded } = loadHdNode();
    const recv = deriveReceivingAddresses(5);
    const chg = deriveChangeAddresses(5);
    eq(recv.length, 5, 'receive count: ');
    eq(chg.length, 5, 'change count: ');
    ok(recv.every((a) => a.address.startsWith('bitcoincash:')), 'receive addresses must be cashaddr on mainnet');
    // Deterministic: deriving again yields identical addresses.
    const again = deriveReceivingAddresses(5);
    eq(JSON.stringify(again), JSON.stringify(recv), 'derivation must be deterministic: ');
    // Receive and change chains must never collide.
    const recvSet = new Set(recv.map((a) => a.address));
    ok(chg.every((a) => !recvSet.has(a.address)), 'change addresses must differ from receive addresses');
    // Indices are recorded, so a caller can resolve back.
    eq(recv[3].index, 3, 'index field: ');
  }

  console.log('--- the path is BIP44 m/44\'/145\'/account\'/change/index ---');
  {
    // Derive the same index independently, step by step, and confirm the wallet
    // agrees. An off-by-one in the ACCOUNT or CHANGE component would still be
    // internally consistent, so the check has to build the path by hand:
    // m / 44' / 145' / 0' / change / index, all hardened except the last two.
    const HARDENED = 0x80000000;
    const manual = (change, index) => deriveHdPrivateNodeChild(
      deriveHdPrivateNodeChild(
        deriveHdPrivateNodeChild(
          deriveHdPrivateNodeChild(hdNode, HARDENED + 44),
          HARDENED + 145,
        ),
        HARDENED + 0,
      ),
      change,
    );
    for (const [change, index] of [[0, 0], [0, 3], [1, 0], [1, 7]]) {
      const expected = deriveHdPrivateNodeChild(manual(change), index);
      const ours = deriveChildPrivKey(hdNode, 0, change, index);
      eq(Buffer.from(ours).toString('hex'), Buffer.from(expected.privateKey).toString('hex'),
        `m/44'/145'/0'/${change}/${index}: `);
    }
    // And the coin type must be BCH's 145, not Bitcoin's 0 -- a wrong coin type
    // would still be self-consistent, so assert it against the manual path.
    const oursZero = Buffer.from(deriveChildPrivKey(hdNode, 0, 0, 0)).toString('hex');
    const bitcoinPath = deriveHdPrivateNodeChild(
      deriveHdPrivateNodeChild(
        deriveHdPrivateNodeChild(
          deriveHdPrivateNodeChild(hdNode, HARDENED + 44),
          HARDENED + 0,
        ),
        HARDENED + 0,
      ),
      0,
    );
    ok(oursZero !== Buffer.from(deriveHdPrivateNodeChild(bitcoinPath, 0).privateKey).toString('hex'),
      'derivation must use coin type 145, not Bitcoin\'s 0');
  }

  console.log('--- a different index gives a different key ---');
  {
    const a = deriveChildPrivKey(hdNode, 0, 0, 0).toString('hex');
    const b = deriveChildPrivKey(hdNode, 0, 0, 1).toString('hex');
    ok(a !== b, 'index 0 and index 1 must not derive the same key');
    const chgKey = deriveChildPrivKey(hdNode, 0, 1, 0).toString('hex');
    ok(a !== chgKey, 'receive /0/0 and change /1/0 must not derive the same key');
  }

  console.log('--- resolveAddressPath round trips ---');
  {
    const recv = deriveReceivingAddresses(20);
    const chg = deriveChangeAddresses(20);
    eq(JSON.stringify(resolveAddressPath(recv[0].address)), JSON.stringify({ account: 0, change: 0, index: 0 }), 'recv[0]: ');
    eq(JSON.stringify(resolveAddressPath(recv[19].address)), JSON.stringify({ account: 0, change: 0, index: 19 }), 'recv[19]: ');
    eq(JSON.stringify(resolveAddressPath(chg[0].address)), JSON.stringify({ account: 0, change: 1, index: 0 }), 'chg[0]: ');
    eq(JSON.stringify(resolveAddressPath(chg[7].address)), JSON.stringify({ account: 0, change: 1, index: 7 }), 'chg[7]: ');
  }

  console.log('--- an unresolvable address THROWS rather than defaulting ---');
  {
    // The whole point. This used to return { index: 0 } and sign with /0/0.
    throws(
      () => resolveAddressPath('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'),
      /cannot resolve the key/,
      'a foreign address must throw'
    );
    throws(() => resolveAddressPath('not-an-address'), /cannot resolve the key/, 'garbage must throw');
    throws(() => resolveAddressPath(undefined), /cannot resolve the key/, 'undefined must throw');
    // Beyond the window: raising it finds the address, which is the point of
    // the error message telling the user to widen the scan.
    const wide = deriveReceivingAddresses(40);
    eq(resolveAddressPath(wide[25].address, { window: 40 }).index, 25, 'a wider window resolves: ');
    throws(() => resolveAddressPath(wide[25].address, { window: 20 }), /cannot resolve the key/, 'narrow window throws: ');
  }

  console.log('--- wallet load round trip ---');
  {
    const w = loadWallet();
    eq(w.network, 'mainnet', 'network: ');
    eq(w.version, 1, 'version: ');
    const p = walletPaths();
    ok(p.wallet === walletFile, 'walletPaths must point at the wallet we wrote');
  }

  console.log('--- the wallet path has exactly one source of truth ---');
  {
    // lib/wallet.mjs and scripts/encrypt-wallet.mjs used to derive this path
    // independently from the same expression. If they diverged, encrypt-wallet
    // would have rewritten a different file than the CLI reads, and the wallet
    // would look like it had lost its funds.
    const viaEnv = resolveWalletPaths({ BCH_WALLET_DIR: '/tmp/explicit-dir' });
    eq(viaEnv.dir, '/tmp/explicit-dir', 'explicit dir: ');
    eq(viaEnv.wallet, '/tmp/explicit-dir/wallet.json', 'explicit wallet path: ');
    eq(viaEnv.state, '/tmp/explicit-dir/state.json', 'explicit state path: ');

    const viaHome = resolveWalletPaths({ HOME: '/home/someone' });
    eq(viaHome.dir, '/home/someone/.bch-wallet', 'default under HOME: ');
    eq(viaHome.wallet, '/home/someone/.bch-wallet/wallet.json', 'default wallet path: ');

    // BCH_WALLET_DIR wins over HOME, and an empty value falls back rather than
    // producing a relative path.
    eq(resolveWalletPaths({ BCH_WALLET_DIR: '/tmp/a', HOME: '/home/b' }).dir, '/tmp/a', 'env wins: ');
    eq(resolveWalletPaths({ BCH_WALLET_DIR: '', HOME: '/home/b' }).dir, '/home/b/.bch-wallet', 'empty env falls back: ');

    // The module-level walletPaths() must agree with resolveWalletPaths() for
    // the same environment -- that agreement is the whole point.
    const now = resolveWalletPaths();
    const p = walletPaths();
    eq(p.dir, now.dir, 'walletPaths dir must match resolveWalletPaths: ');
    eq(p.wallet, now.wallet, 'walletPaths wallet must match resolveWalletPaths: ');
    eq(p.state, now.state, 'walletPaths state must match resolveWalletPaths: ');
  }

  console.log('--- new address counters advance and stay in-bounds ---');
  {
    const first = newReceivingAddress();
    const second = newReceivingAddress();
    ok(first.address !== second.address, 'each new receiving address must be distinct');
    ok(second.index > first.index, 'the receive counter must advance');
    const c1 = newChangeAddress();
    const c2 = newChangeAddress();
    ok(c1.address !== c2.address, 'each new change address must be distinct');
  }
} finally {
  if (oldDir === undefined) delete process.env.BCH_WALLET_DIR; else process.env.BCH_WALLET_DIR = oldDir;
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
