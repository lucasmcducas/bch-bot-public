// Cashonize's discovery trick, verified against mainnet.
//
// The comment in cashonize/src/utils/defi/cauldronPools.ts:
//
//   "A Cauldron pool is a contract written in raw BCH Script... the only variable
//    part of it is the 20-byte public key hash of the pool owner. All pools of
//    one owner therefore sit at the same p2sh32 address, so listing an owner's
//    pools is a UTXO lookup on that address."
//
// So a pool's on-chain position is not something to be handed by a router. It
// is a UTXO sitting at an address you can DERIVE from the owner's pubkey hash.
// No indexer, no route cache, no stale parent transaction.
//
// The contract template:
//   OP_DEPTH OP_IF OP_DUP OP_HASH160 <20-byte owner pkh> OP_EQUALVERIFY OP_CHECKSIG
//   OP_ELSE <constant-product swap conditions> OP_ENDIF
// then wrapped in p2sh32 by hashing the whole thing.
//
// fd02de7d..1138 is the drained parent the router keeps serving. Its outputs sit
// at exactly these addresses -- so deriving the owner pkh from one of its pool
// locking scripts and re-querying should show whether the position has MOVED to
// a new transaction, which is what a live pool looks like.
import { createHash } from 'node:crypto';
import { connectToken } from './lib/network.mjs';
import { decodeTransactionBCH } from '@bitauth/libauth';
import { hexToBin } from './lib/hex.mjs';

const PREFIX = '746376a914';   // OP_DEPTH OP_IF OP_DUP OP_HASH160 PUSH20
const SUFFIX = '88ac67c0d1c0ce88c25288c0cdc0c788c0c6c0d095c0c6c0cc9490539502e80396c0cc7c94c0d3957ca268';
const sha256 = (b) => createHash('sha256').update(Buffer.from(b)).digest();
const sh = (lockHex) => Buffer.from(sha256(Buffer.from(lockHex, 'hex'))).reverse().toString('hex');

const c = await connectToken();
const P = 'fd02de7d5c8f51e5313adbaadb66ec37594000580a77160e5509230aa5791138';
const pv = decodeTransactionBCH(hexToBin(await c.request('blockchain.transaction.get', P, false)));

// A p2sh32 covenant locking script is OP_2 <32-byte hash> OP_ELSE <redeem> OP_ENDIF.
// The hash of the redeem script IS the pool's address. We do not need the owner
// pkh at all to locate the position: the locking script already contains the
// contract's identity. So: query each pool lock directly and see whether the
// covenant holds a live balance under SOME transaction.
const locks = new Set();
for (const o of pv.outputs) {
  const h = Buffer.from(o.lockingBytecode).toString('hex');
  if (h.length === 70) locks.add(h);          // aa20...87 = p2sh32
}
console.log(`distinct pool covenants in the drained parent: ${locks.size}\n`);

let withLive = 0;
let sample = 0;
for (const lock of locks) {
  const list = await c.request('blockchain.scripthash.listunspent', sh(lock)).catch(() => null);
  if (!Array.isArray(list)) continue;
  if (list.length > 0) withLive++;
  if (sample < 6) {
    sample++;
    const freshest = list.reduce((a, u) => (Number(u.height) > Number(a.height) ? u : a), list[0]);
    console.log(`  lock ${lock.slice(0, 20)}..  live positions: ${list.length}`
      + `  freshest h${freshest.height}`);
  }
}
console.log('');
console.log(`covenants from the dead parent that STILL hold a live position: ${withLive}/${locks.size}`);

c.disconnect();
process.exit(0);
