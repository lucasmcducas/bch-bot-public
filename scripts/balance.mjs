#!/usr/bin/env node
// scripts/balance.mjs — query wallet balance via Rostrum/Electrum
//
// Usage: node scripts/balance.mjs [--network chipnet|mainnet] [--verbose]
//
// Pattern from Selene Wallet ElectrumService:
//   - blockchain.scripthash.get_balance(scripthash) returns { confirmed, unconfirmed }
//   - blockchain.scripthash.listunspent(scripthash) returns UTXOs with token_data
//
// Walks both receiving (m/44'/145'/0'/0/i) and change (m/44'/145'/0'/1/i) chains.
// Token summary groups by category id and prints sorted by total FT amount.

import { connect, scripthashForAddress, listUnspent,
} from '../lib/network.mjs';
import {
  loadWallet,
  deriveReceivingAddresses,
  deriveChangeAddresses,
} from '../lib/wallet.mjs';
import { sumFtBalances } from '../lib/tokens.mjs';
import { describeToken } from '../lib/token-registry.mjs';

const RECEIVING_GAP = 20;
const CHANGE_GAP = 20;

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { verbose: false, network: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--network') out.network = args[++i];
    if (args[i] === '--verbose' || args[i] === '-v') out.verbose = true;
    if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: balance.mjs [--network chipnet|mainnet] [--verbose]');
      process.exit(0);
    }
  }
  return out;
}

async function queryChain(client, addrs, opts) {
  let confirmed = 0n;
  let unconfirmed = 0n;
  const allUtxos = [];
  for (const a of addrs) {
    const sh = scripthashForAddress(a.address);
    const bal = await client.request('blockchain.scripthash.get_balance', sh);
    if (typeof bal === 'string') continue;
    confirmed += BigInt(bal.confirmed ?? 0);
    unconfirmed += BigInt(bal.unconfirmed ?? 0);
    const utxos = await listUnspent(client, sh);
    if (Array.isArray(utxos)) {
      for (const u of utxos) {
        allUtxos.push({ address: a.address, ...u });
        if (opts.verbose) {
          const tag = u.height > 0 ? `block ${u.height}` : 'mempool';
          const tokens = u.token_data ? ` token[${u.token_data.category.slice(0,8)}…:${u.token_data.amount}${u.token_data.nft ? ' NFT' : ''}]` : '';
          console.error(`  ${a.address}  ${u.value} sats  (${tag})${tokens}`);
        }
      }
    }
  }
  return { confirmed, unconfirmed, utxos: allUtxos };
}

async function main() {
  const opts = parseArgs();
  const w = loadWallet();
  if (!w) { console.error('no wallet; run create-wallet.mjs first'); process.exit(1); }
  const network = opts.network || w.network;
  console.error(`network: ${network}`);

  const client = await connect(network);
  try {
    if (opts.verbose) {
      console.error(`scanning first ${RECEIVING_GAP} receiving addresses + ${CHANGE_GAP} change addresses...`);
    }
    const recv = await queryChain(client, deriveReceivingAddresses(RECEIVING_GAP), opts);
    const chg = await queryChain(client, deriveChangeAddresses(CHANGE_GAP), opts);

    const totalConfirmed = recv.confirmed + chg.confirmed;
    const totalUnconfirmed = recv.unconfirmed + chg.unconfirmed;
    const allUtxos = [...recv.utxos, ...chg.utxos];

    // Token summary: split FT-only from NFT, sort by FT amount desc
    const ftSums = sumFtBalances(allUtxos, { ftOnly: true });
    const nftList = [];
    for (const u of allUtxos) {
      if (u.token_data?.nft) {
        nftList.push({
          category: u.token_data.category,
          capability: u.token_data.nft.capability,
          commitment: u.token_data.nft.commitment || '',
          value_sats: u.value,
          address: u.address,
          tx_hash: u.tx_hash,
          tx_pos: u.tx_pos,
        });
      }
    }

    const tokensBlock = {};
    if (ftSums.size > 0) {
      const sortedCats = [...ftSums.entries()].sort((a, b) => Number(b[1] - a[1]));
      for (const [cat, amt] of sortedCats) {
        // Carry the symbol, the decimals, and a display string alongside the raw
        // base units. A UI cannot turn 100 base units into "1 ROACH" on its
        // own -- CashTokens base units carry no decimal metadata, so the
        // decimals have to come from the wallet or the user sees a raw integer.
        // `amount` stays the exact base-unit figure, because that is what a
        // signer must use and a display string must never be parsed back.
        tokensBlock[cat] = {
          ...describeToken(cat, amt),
          short_id: cat.slice(0, 16) + '…',
        };
      }
    }

    console.log(JSON.stringify({
      network,
      satoshis_confirmed: totalConfirmed.toString(),
      satoshis_unconfirmed: totalUnconfirmed.toString(),
      bch_confirmed: (Number(totalConfirmed) / 1e8).toFixed(8),
      bch_unconfirmed: (Number(totalUnconfirmed) / 1e8).toFixed(8),
      utxo_count: allUtxos.length,
      token_categories_ft: ftSums.size,
      tokens: tokensBlock,
      nfts: nftList.length > 0 ? nftList : undefined,
    }, null, 2));
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });