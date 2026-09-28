#!/usr/bin/env node
// scripts/utxos.mjs — list UTXOs at wallet's receiving addresses (BCH only, tokens passed through)
//
// Usage: node scripts/utxos.mjs [--network chipnet|mainnet]

import { connect, scripthashForAddress } from '../lib/network.mjs';
import { loadWallet, deriveReceivingAddresses } from '../lib/wallet.mjs';

async function main() {
  const w = loadWallet();
  if (!w) { console.error('no wallet; run create-wallet.mjs first'); process.exit(1); }
  console.error(`network: ${w.network}`);

  const client = await connect(w.network);
  try {
    const addrs = deriveReceivingAddresses(20);
    const allUtxos = [];
    for (const a of addrs) {
      const sh = scripthashForAddress(a.address);
      const utxos = await client.request('blockchain.scripthash.listunspent', sh);
      if (Array.isArray(utxos)) {
        for (const u of utxos) {
          allUtxos.push({ address: a.address, ...u });
        }
      }
    }
    console.log(JSON.stringify(allUtxos, null, 2));
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });