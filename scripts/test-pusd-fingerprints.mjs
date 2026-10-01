// scripts/test-pusd-fingerprints.mjs
//
// lib/pusd.mjs shipped five truncated fingerprints ("4bb467b6...") and one
// fabricated string whose tail was invented but looked like a real hash. A
// fingerprint is a contract-identity check, so a wrong value either always
// fails or -- worse, if compared by prefix -- always passes for a substituted
// contract.
//
// These assertions pin every value to the literal published in
// @paryonusd/contracts v1.0.0. If a future bump of that package changes a
// fingerprint, this test fails and the constant is re-read from the package
// rather than guessed. The no-placeholder assertions are the real point: they
// fail if anyone reintroduces a truncation.

import { ARTIFACT_FINGERPRINTS, isKnownArtifactFingerprint, assertKnownArtifactFingerprint } from '../lib/pusd.mjs';

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

console.log('--- every fingerprint is a full 32-byte hex string ---');
for (const [name, value] of Object.entries(ARTIFACT_FINGERPRINTS)) {
  ok(/^[0-9a-f]{64}$/.test(value), `${name} must be 64 lowercase hex chars, got "${value}"`);
  ok(!value.includes('...'), `${name} must not be a truncation: "${value}"`);
}

console.log('--- the values match @paryonusd/contracts v1.0.0 ---');
const PUBLISHED = {
  AddLiquidity: 'f46099a7e734f5f0ec466ae997296e8ade8be45426394adda6bf61977fe478fa',
  StabilityPool: 'e2136acf16013e341012ea1fb48cbb59972c2d0f8db6d9bf3c15f079be2607f3',
  StabilityPoolSidecar: '4bb467b6b82a9fb063eaa951abff7e03075c5ad3cb0f47fa83b5848a4ac6c1fd',
  WithdrawFromPool: 'dfecf8b4e84a528682aee6d600101ac47d15b169d4e7d7ced51eab724cbeda4a',
  Payout: '26e6cf01b4ca42263b287a42d776e1bd458400b89b95abfd61514a38d1ca38bb',
  NewPeriodPool: '2b7045d451c246f5e256f5acf1cbe234cab447deb2c37874666fb68f4e19ded0',
};
eq(Object.keys(ARTIFACT_FINGERPRINTS).length, Object.keys(PUBLISHED).length, 'fingerprint count: ');
for (const [name, value] of Object.entries(PUBLISHED)) {
  eq(ARTIFACT_FINGERPRINTS[name], value, `${name}: `);
}

console.log('--- the previously fabricated StabilityPool value is gone ---');
ok(
  ARTIFACT_FINGERPRINTS.StabilityPool !== 'e2136acf6f1cbb1a0fce6b1bece6b1bece6b1bece',
  'StabilityPool must not be the invented placeholder'
);
ok(
  ARTIFACT_FINGERPRINTS.StabilityPool.startsWith('e2136acf'),
  'StabilityPool must start with the real e2136acf prefix from the package'
);

console.log('--- recognition ---');
for (const [name, value] of Object.entries(ARTIFACT_FINGERPRINTS)) {
  ok(isKnownArtifactFingerprint(value), `${name} must be recognised`);
}
ok(isKnownArtifactFingerprint(ARTIFACT_FINGERPRINTS.Payout.toUpperCase()), 'case must not matter');

console.log('--- unknown values are refused, not waved through ---');
throws(() => assertKnownArtifactFingerprint('deadbeef'), /unrecognised/, 'a short hash must be refused');
throws(() => assertKnownArtifactFingerprint('4bb467b6...'), /unrecognised/, 'a truncation must be refused');
throws(() => assertKnownArtifactFingerprint(''), /unrecognised/, 'an empty string must be refused');
throws(() => assertKnownArtifactFingerprint(undefined), /unrecognised/, 'undefined must be refused');
throws(() => assertKnownArtifactFingerprint(null), /unrecognised/, 'null must be refused');
throws(() => assertKnownArtifactFingerprint(42), /unrecognised/, 'a number must be refused');
// A contract that differs in one character must not match.
throws(
  () => assertKnownArtifactFingerprint(ARTIFACT_FINGERPRINTS.Payout.replace(/^26/, '27')),
  /unrecognised/,
  'a one-character difference must be refused'
);
// A prefix of a real fingerprint must not be accepted -- that is the exact
// failure mode a truncated constant would have produced.
throws(
  () => assertKnownArtifactFingerprint(ARTIFACT_FINGERPRINTS.Payout.slice(0, 16)),
  /unrecognised/,
  'a prefix must not be accepted'
);

console.log(`\nRESULT: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
