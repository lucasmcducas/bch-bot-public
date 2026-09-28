#!/usr/bin/env node
// scripts/history.mjs — list transactions touching wallet addresses (receiving + change)
//
// Usage: node scripts/history.mjs [--limit N] [--network chipnet|mainnet]
//
// Pattern from Selene Wallet AddressScannerService (transaction backfill).
// Uses Electrum's blockchain.scripthash.get_history for each derived address.
// De-duplicates by txid (a tx touching multiple addresses is listed once).
//
// Output: JSON array of { tx_hash, fee, height, addresses[] }, sorted newest first.

import { connect, scripthashForAddress } from '../lib/network.mjs';
import {
  loadWallet,
  deriveReceivingAddresses,
  deriveChangeAddresses,
} from '../lib/wallet.mjs';

const DEFAULT_GAP = 20;
const DEFAULT_LIMIT = 50;

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { limit: DEFAULT_LIMIT, network: null, gap: DEFAULT_GAP };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' || args[i] === '-n') out.limit = parseInt(args[++i], 10);
    if (args[i] === '--gap') out.gap = parseInt(args[++i], 10);
    if (args[i] === '--network') out.network = args[++i];
    if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: history.mjs [--limit N] [--gap N] [--network chipnet|mainnet]');
      process.exit(0);
    }
  }
  return out;
}

async function main() {
  const opts = parseArgs();
  const w = loadWallet();
  if (!w) { console.error('no wallet; run create-wallet.mjs first'); process.exit(1); }
  const network = opts.network || w.network;
  console.error(`network: ${network}, gap=${opts.gap}, limit=${opts.limit}`);

  const client = await connect(network);
  try {
    const addrs = [...deriveReceivingAddresses(opts.gap), ...deriveChangeAddresses(opts.gap)];

    // Map tx_hash -> { ...history entry, addresses[] }
    const txs = new Map();
    for (const a of addrs) {
      const sh = scripthashForAddress(a.address);
      const hist = await client.request('blockchain.scripthash.get_history', sh);
      if (!Array.isArray(hist)) continue;
      for (const h of hist) {
        if (!txs.has(h.tx_hash)) {
          txs.set(h.tx_hash, { ...h, addresses: [] });
        }
        txs.get(h.tx_hash).addresses.push(a.address);
      }
    }

    // Sort newest first (height desc; mempool entries have height=0)
    const sorted = [...txs.values()].sort((a, b) => b.height - a.height);
    const limited = sorted.slice(0, opts.limit);

    console.error(`found ${txs.size} tx(es); showing ${limited.length}`);
    console.log(JSON.stringify(limited.map((t) => ({
      tx_hash: t.tx_hash,
      fee: t.fee,
      height: t.height,
      status: t.height === 0 ? 'mempool' : 'confirmed',
      addresses: t.addresses,
    })), null, 2));
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });