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
  loadState,
  scanCount,
  deriveReceivingAddresses,
  deriveChangeAddresses,
} from '../lib/wallet.mjs';
import { sumFtBalances } from '../lib/tokens.mjs';
import { describeToken } from '../lib/token-registry.mjs';

// Gap limits for the address scan.
//
// A fixed window of 20 is wrong on both sides. The wallet's own state tracks the
// next unused index on each chain, and a UTXO can exist at ANY index the wallet
// has ever derived -- including change addresses well past 20. Measured on
// 2026-10-02: this wallet held 855,311 sat on change index 38, and `balance`
// reported 0.00803 BCH because it only looked at indices 0..19. The money was
// never lost; the tool could not see it.
//
// So: scan up to the wallet's own counter (plus a small forward window for
// addresses reserved but not yet used), with a floor so an empty state file
// still scans something useful, and a ceiling so a corrupted counter cannot
// trigger thousands of derivations on a 4-core box.

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

  // Derive the scan window from the wallet's own counters, so a UTXO on a high
  // change index is visible. Declared before the verbose block because the scan
  // itself needs it, not just the log line.
  const st = loadState();
  const recvCount = scanCount('address_index', st);
  const chgCount = scanCount('change_index', st);

  const client = await connect(network);
  try {
    if (opts.verbose) {
      console.error(
        `scanning ${recvCount} receiving + ${chgCount} change addresses ` +
        `(state: addr ${st.address_index}, change ${st.change_index})...`
      );
    }
    const recv = await queryChain(client, deriveReceivingAddresses(recvCount), opts);
    const chg = await queryChain(client, deriveChangeAddresses(chgCount), opts);

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