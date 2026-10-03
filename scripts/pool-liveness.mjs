// Are the indexer's pool outpoints ACTUALLY unspent?
//
// This single fact decides the approach. Our router picked a drained parent and
// every swap died. The indexer reports 60 active PUSD pools across 8 parents --
// but "active" is the indexer's word, not the chain's.
//
// Method notes, both learned the hard way in this repo:
//   - request is variadic: (method, txid, false), never an array. Passing an
//     array yields an empty object, which reads as "found, but no vouts" and
//     makes every output look nonexistent.
//   - verbose=false returns a raw hex string, not JSON. Decode it.
//   - libauth gives wire order, Electrum reports display order (byte-reversed).
//     Compare against BOTH or every coin looks spent.
//
// Read-only. Signs nothing, moves nothing.

import { connectToken } from '../lib/network.mjs';
import { decodeTransactionBCH } from '@bitauth/libauth';
import { createHash } from 'node:crypto';

const CAT = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';

const revHex = (h) => Buffer.from(h, 'hex').reverse().toString('hex');
const shOf = (l) => Buffer.from(createHash('sha256').update(Buffer.from(l)).digest()).reverse().toString('hex');

const res = await fetch(`https://indexer.riften.net/cauldron/pool/active?token=${CAT}`);
const pools = (await res.json()).active;
console.log(`${pools.length} active pools reported by indexer.riften.net`);

const byParent = new Map();
for (const p of pools) {
  if (!byParent.has(p.txid)) byParent.set(p.txid, []);
  byParent.get(p.txid).push(p);
}

const c = await connectToken('mainnet');
let livePools = 0, liveSats = 0, spent = 0, missing = 0, listed = 0;
const rows = [];

try {
  for (const [txid, ps] of byParent) {
    let decoded = null;
    for (const cand of [txid, revHex(txid)]) {
      const r = await c.request('blockchain.transaction.get', cand, false).catch(() => null);
      if (typeof r === 'string') { decoded = decodeTransactionBCH(Buffer.from(r, 'hex')); break; }
    }
    const sats = ps.reduce((a, p) => a + (p.sats || 0), 0);
    if (!decoded) { rows.push(`  ${txid.slice(0, 18)}…  parent NOT FOUND`); missing += ps.length; continue; }

    let ok = 0, nodeListed = 0;
    for (const p of ps) {
      const v = p.tx_pos;
      if (!decoded.outputs[v]) { missing++; continue; }
      const list = await c.request('blockchain.scripthash.listunspent', [shOf(decoded.outputs[v].lockingBytecode)]).catch(() => null);
      const want = new Set([txid, revHex(txid)]);
      const hit = Array.isArray(list) && list.find((u) => want.has(u.tx_hash) && Number(u.tx_pos) === v);
      if (hit) { nodeListed++; ok++; livePools++; liveSats += p.sats || 0; }
      else { spent++; rows.push(`  ${txid.slice(0, 12)}…v${v}  NOT in node's unspent set (${p.sats} sats)`); }
    }
    rows.push(`  ${txid.slice(0, 18)}…  ${String(ok).padStart(2)}/${ps.length} live   ${String(sats).padStart(12)} sats   (${nodeListed} node-confirmed)`);
  }
} finally {
  try { c.close(); } catch { /* already closed */ }
}

console.log();
for (const r of rows) console.log(r);
console.log();
console.log(`  LIVE pools:  ${livePools}/${pools.length}   (${liveSats} sats = ${(liveSats / 1e8).toFixed(4)} BCH)`);
console.log(`  not listed:  ${spent}`);
console.log(`  missing vout:${missing}`);
process.exit(0);
