// Why the swap is rejected: the 13 pool UTXOs are already spent.
//
// The node's real verdict, read off the wire instead of through the client
// library (which collapses the JSON-RPC error into an empty object):
//
//   broadcast <our tx>  ERROR code=-32000
//     "RPC error (-32602 InvalidParams): rejected by network; RPC error
//      (-32000 Other): Call 'sendrawtransaction' to full node failed: Missing inputs"
//
//   broadcast "00"      ERROR -32603 "failed to parse tx"     <-- different failure
//
// "Missing inputs" means an outpoint is absent from the UTXO set. It is NOT a
// covenant-evaluation error and NOT a malformed transaction: the node parsed
// ours fine and handed it to the full node, which then could not find the coins.
//
// The parents all exist, so it is not that the transactions are unknown. It is
// that their outputs have been spent. This test pins the distinction, because
// "Missing inputs" is routinely misread as "the node cannot handle covenants",
// which sends you off to rebuild the transaction when the route is simply dead.
//
// These two tests need a real signed swap as a fixture, because the property
// they check (the re-creation rule, and whether a router's chosen outpoints are
// still live) only means anything against a transaction the router actually
// built. There is no synthetic substitute: a hand-written transaction would
// pass or fail for reasons of its own construction rather than the rule.
//
// The fixture is NOT in the repo -- it is a few KB of signed hex whose pool
// inputs are consumed within seconds of being built, so committing one would
// freeze a snapshot that is dead on arrival. Instead:
//
//   node scripts/swap.mjs BCH pusd 0.001          # dry-run, prints the build
//   node scripts/test-cauldron-k-invariant.mjs <path-to-hex>
//   node scripts/test-swap-prevout-liveness.mjs <path-to-hex>
//
// They are deliberately NOT wired into `npm test`, which must stay runnable
// offline and without a wallet. A test that needs mainnet state to answer
// belongs in a manual gate, not in a suite that anyone trusts to be green.
//
// Usage:  node scripts/test-swap-prevout-liveness.mjs [tx-hex-file]
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { decodeTransactionBCH } from '@bitauth/libauth';
import { hexToBin } from '../lib/hex.mjs';
import { connectToken, listUnspent } from '../lib/network.mjs';

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

const path = process.argv[2] || '/tmp/tx.hex';
let hex;
try { hex = readFileSync(path, 'utf8').trim(); }
catch {
  console.error(`no transaction fixture at ${path}`);
  console.error('build one:  node scripts/swap.mjs BCH pusd 0.001');
  console.error('then pass the hex file:  ' + process.argv[1] + ' <file>');
  process.exit(1);
}

const tx = decodeTransactionBCH(hexToBin(hex));
const c = await connectToken('mainnet');

const wireOf = (u8) => Buffer.from(u8).toString('hex');
const revHex = (h) => Buffer.from(h).reverse().toString('hex');
// Electrum scripthash: sha256 of the locking script, byte-reversed.
const shOf = (l) => Buffer.from(createHash('sha256').update(Buffer.from(l)).digest()).reverse().toString('hex');

// Fetch each distinct parent. `request` is variadic: (method, txid, verbose) --
// never an array. libauth's outpoint hash is wire order, Electrum wants the
// byte-reversed display order, so try both.
const parents = new Map();
for (let n = 0; n < tx.inputs.length; n++) {
  const w = wireOf(tx.inputs[n].outpointTransactionHash);
  if (parents.has(w)) continue;
  for (const cand of [w, revHex(w)]) {
    const r = await c.request('blockchain.transaction.get', cand, false).catch(() => null);
    if (typeof r === 'string') { parents.set(w, decodeTransactionBCH(hexToBin(r))); break; }
  }
}
check('every input parent is retrievable', parents.size > 0, `${parents.size} distinct`);

let poolUnspent = 0, oursUnspent = 0, poolTotal = 0, oursTotal = 0;
const rows = [];

for (let n = 0; n < tx.inputs.length; n++) {
  const w = wireOf(tx.inputs[n].outpointTransactionHash);
  const v = Number(tx.inputs[n].outpointIndex);
  const pin = parents.get(w)?.outputs[v];
  if (!pin) { rows.push(`  in[${n}] v${v}: parent output missing`); continue; }

  const list = await listUnspent(c, shOf(pin.lockingBytecode)).catch(() => null);
  if (!Array.isArray(list)) { rows.push(`  in[${n}] v${v}: listunspent failed`); continue; }

  // Byte order is the trap here, and it is NOT visible from a field name. The
  // same txid comes back in two orderings depending on who computed it: libauth
  // hands out wire order, Electrum's listunspent reports display order, which
  // is the byte-reverse. Compare against BOTH or every coin reads as spent --
  // I hit that and briefly believed the wallet's own inputs were gone.
  const want = new Set([w, revHex(w)]);
  const hit = list.find(u => want.has(u.tx_hash) && Number(u.tx_pos) === v);
  const ours = n >= tx.inputs.length - 2;
  if (ours) oursTotal++; else poolTotal++;
  if (hit) { ours ? oursUnspent++ : poolUnspent++; }
  rows.push(`  in[${String(n).padStart(2)}] v${String(v).padStart(2)}  ${hit ? `UNSPENT (${hit.value} sats, h${hit.height})` : 'spent / absent'}${ours ? '   <- ours' : ''}`);
}

rows.forEach(r => console.log(r));
console.log('');
check('all parents exist (so "Missing inputs" means spent, not unknown)',
  parents.size > 0);
check('the wallet\'s own inputs are unspent',
  oursTotal > 0 && oursUnspent === oursTotal, `${oursUnspent}/${oursTotal}`);
check('pool inputs reported dead -- the actual cause of the rejection',
  poolTotal > 0 && poolUnspent === 0, `${poolUnspent}/${poolTotal} still unspent`);

c.disconnect();
console.log(`\nRESULT: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed === 0 ? 0 : 1);
