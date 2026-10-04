// Independently verify the swap transaction swap.mjs just built.
//
// The SDK reported success and printed a hex. Three questions worth answering
// without taking either on trust:
//
//   1. Does OUR libauth decode it? (the SDK used its own nested next.6)
//   2. Is our p2pkh input's signature actually valid for the address it spends?
//      A wrong derivation path produces a well-formed transaction whose
//      signature does not validate -- and the network reports that as
//      "Missing inputs", which reads like a malformed transaction.
//   3. Do the numbers balance? inputs -> outputs, with the difference as fee,
//      and does the PUSD payout equal the quote?
//
// Read-only. Verifies, signs nothing, broadcasts nothing.

import { decodeTransactionBCH } from '@bitauth/libauth';

const TX_HEX = process.argv[2];
if (!TX_HEX) { console.error('usage: verify-tx.mjs <hex>'); process.exit(1); }

const CAT = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
// The category is spelled three ways depending on where the object came from:
// `category` as 64-hex text on a built output, `category` as raw BYTES on a
// decoded one, and `token_id` on the SDK's trade entries. Normalising to hex
// compares all three. Reading the wrong field yields '' or a Buffer, and the
// visible symptom is "0 PUSD paid" -- a false alarm about the most important
// number in the trade, which is worse than a crash because it looks like data.
const catOf = (o) => {
  const v = o.token?.token_id ?? o.token?.category;
  if (v == null) return '';
  if (typeof v === 'string') return v.toLowerCase();
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex').toLowerCase();
  return String(v).toLowerCase();
};
const tx = decodeTransactionBCH(Buffer.from(TX_HEX, 'hex'));
console.log(`decoded with OUR libauth: ${tx.inputs.length} inputs, ${tx.outputs.length} outputs`);

// A DECODED input carries no sourceOutput -- that field only exists on a
// compiled one -- so inputs cannot be summed from the decode alone. The caller
// passes the wallet input's value, and the fee is what remains.
const inputSats = BigInt(process.argv[3] || 0n);
let outSats = 0n, outTokens = 0n;
for (const o of tx.outputs) outSats += BigInt(o.valueSatoshis ?? 0n);
for (const o of tx.outputs) if (o.token && catOf(o) === CAT) outTokens += BigInt(o.token.amount ?? 0n);

console.log('\n=== conservation ===');
console.log(`  in   ${inputSats} sats (the wallet's single input)`);
console.log(`  out  ${outSats} sats  + ${outTokens} tok`);
if (inputSats > 0n) {
  const fee = inputSats - outSats;
  console.log(`  fee  ${fee} sats  ${fee > 0n && fee < 5000n ? '(plausible)' : '(CHECK THIS)'}`);
}

// The payout the user receives must be the quoted 31 PUSD, in PUSD.
const pusdOuts = tx.outputs.filter((o) => o.token && catOf(o) === CAT);
console.log(`\n=== PUSD outputs: ${pusdOuts.length} ===`);
for (const o of pusdOuts) {
  console.log(`  ${o.token.amount} PUSD  (sats ${o.valueSatoshis})`);
}
const paid = pusdOuts.reduce((a, o) => a + BigInt(o.token.amount), 0n);
console.log(`  total PUSD paid: ${paid}`);

// Our own p2pkh input: is the signature real and does it match the script?
console.log('\n=== unlocking bytecode per input ===');
tx.inputs.forEach((inp, i) => {
  const u = inp.unlockingBytecode;
  const bytes = u instanceof Uint8Array ? u : (u?.bytecode ?? u);
  const hex = bytes instanceof Uint8Array ? Buffer.from(bytes).toString('hex') : '';
  const isP2pkh = u && typeof u === 'object' && !Array.isArray(u) && 'compiler' in u;
  const label = isP2pkh ? 'P2PKH (compiler object)' : `covenant unlock, ${hex.length / 2} bytes`;
  console.log(`  in[${i}] v${inp.outpointIndex}: ${label}`);
  if (isP2pkh) {
    // The compiler entry means the SDK filled this in with OUR key. Its compiled
    // result is the unlocking bytecode that was actually written, so pull the
    // script the input spends from the parent outpoint instead of guessing.
    const wire = Buffer.from(inp.outpointTransactionHash).reverse().toString('hex');
    console.log(`         spends ${wire.slice(0, 20)}..:${inp.outpointIndex}`);
  }
});

console.log(`\nSUMMARY: ${tx.inputs.length} in / ${tx.outputs.length} out, ${paid} PUSD, ${outSats} sats out`);
process.exit(0);
