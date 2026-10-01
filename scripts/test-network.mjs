// scripts/test-network.mjs
//
// lib/network.mjs had zero tests. scripthashForAddress feeds every UTXO query
// in the codebase -- get it wrong and the wallet silently reports an empty
// balance, which is indistinguishable from having no money.
//
// The expected values are computed from the spec (SHA-256 of the locking
// script, byte-reversed, per the Electrum protocol) INDEPENDENTLY of the
// implementation, so a change to the implementation cannot quietly change the
// expectation. Note it is a SINGLE sha256, not a double hash: hash256 is the
// Bitcoin txid rule and would produce a different, wrong answer.

import { scripthashForAddress, connect, SERVERS } from '../lib/network.mjs';
import { encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress, sha256 } from '@bitauth/libauth'

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
// connect() is async, so its guard rejects rather than throws synchronously.
// An unhandled rejection must be an explicit failure, not a silent pass.
async function rejects(promise, re, m) {
  try { await promise; } catch (e) {
    if (re.test(e.message)) { passed++; return; }
    failed++; console.error(`  ✗ ${m}: wrong error: ${e.message}`); return;
  }
  failed++; console.error(`  ✗ ${m}: expected a rejection`);
}

// The spec reference, written out independently of the function under test.
const specScripthash = (lockingBytecode) =>
  Buffer.from(sha256.hash(lockingBytecode)).reverse().toString('hex');

const addrFor = (lockingBytecode) =>
  lockingBytecodeToCashAddress({ bytecode: lockingBytecode }).address;

console.log('--- scripthash matches the Electrum spec ---');
{
  for (const fill of [0x00, 0x01, 0x7f, 0x80, 0xff, 0xab]) {
    const lock = encodeLockingBytecodeP2pkh(new Uint8Array(20).fill(fill));
    eq(scripthashForAddress(addrFor(lock)), specScripthash(lock), `fill 0x${fill.toString(16)}: `);
  }
}

console.log('--- it is a single SHA-256, not a double hash ---');
{
  // A regression to hash256 would still return a plausible 64-char string and
  // every balance would read as zero. Assert the single-hash rule explicitly.
  const lock = encodeLockingBytecodeP2pkh(new Uint8Array(20).fill(3));
  const single = specScripthash(lock);
  const doubled = Buffer.from(
    sha256.hash(sha256.hash(lock))
  ).reverse().toString('hex');
  ok(single !== doubled, 'the two must differ, or this assertion proves nothing');
  eq(scripthashForAddress(addrFor(lock)), single, 'must be the single-hash value: ');
}

console.log('--- the result is a 32-byte lowercase hex string ---');
{
  const s = scripthashForAddress('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a');
  ok(/^[0-9a-f]{64}$/.test(s), `expected 64 lowercase hex chars, got "${s}"`);
}

console.log('--- distinct addresses give distinct scripthashes ---');
{
  const a = scripthashForAddress('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a');
  const b = scripthashForAddress('bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy');
  ok(a !== b, 'two different addresses must not collide');
}

console.log('--- a bad address throws rather than hashing garbage ---');
{
  // Hashing garbage would produce a valid-looking 64-char string; the query
  // would return empty and the wallet would report no funds. Refusing is the
  // only safe behaviour, so a bad checksum must be caught.
  throws(() => scripthashForAddress('not-an-address'), /decode failed/, 'garbage must be refused');
  throws(() => scripthashForAddress(''), /decode failed/, 'empty string must be refused');
  throws(() => scripthashForAddress('bitcoincash:'), /decode failed/, 'prefix only must be refused');
  // A one-character corruption of a real address: the checksum must catch it.
  const real = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
  const corrupt = real.slice(0, -1) + (real.endsWith('a') ? 'b' : 'a');
  throws(() => scripthashForAddress(corrupt), /decode failed/, 'a bad checksum must be refused');
  throws(() => scripthashForAddress(undefined), /decode failed/, 'undefined must be refused');
  throws(() => scripthashForAddress(null), /decode failed/, 'null must be refused');
}

console.log('--- connect() requires an explicit, known network ---');
{
  // The silent chipnet fallback is the bug this guards: a mainnet wallet
  // querying chipnet scripthashes reports "no UTXOs" rather than an error.
  await rejects(connect(), /requires an explicit network/, 'no argument must be refused');
  await rejects(connect(''), /requires an explicit network/, 'empty string must be refused');
  await rejects(connect(null), /requires an explicit network/, 'null must be refused');
  await rejects(connect(42), /requires an explicit network/, 'a number must be refused');
  await rejects(connect('miannet'), /unknown network/, 'a typo must be refused by name');
  await rejects(connect('mainnetn'), /unknown network/, 'another typo must be refused');
  await rejects(connect('CHIPNET'), /unknown network/, 'network names are case-sensitive');
}

console.log('--- every advertised network has a server list ---');
{
  for (const [name, list] of Object.entries(SERVERS)) {
    ok(Array.isArray(list) && list.length > 0, `${name} must have at least one server`);
    for (const entry of list) {
      ok(/^[^\s:]+:\d+$/.test(entry), `${name} server "${entry}" must be host:port`);
    }
  }
  for (const expected of ['mainnet', 'chipnet', 'testnet3', 'testnet4', 'cauldron']) {
    ok(expected in SERVERS, `${expected} must be a known network`);
  }
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
