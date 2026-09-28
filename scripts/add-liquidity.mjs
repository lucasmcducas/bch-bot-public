#!/usr/bin/env node
// scripts/add-liquidity.mjs — add liquidity to a Cauldron pool (Phase 4)
//
// Usage:
//   node scripts/add-liquidity.mjs <token_id> <bch_sats> <token_base_units> [--first] [--broadcast]
//   node scripts/add-liquidity.mjs 2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544 1000000 1000000
//
// Example (PUSD pool):
//   node scripts/add-liquidity.mjs 2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544 1000000 1000000 --first
//
// --first: create a NEW pool (no existing pool needed)
//   --broadcast: actually broadcast the tx (default is dry-run)
//
// PRE-REQUISITES:
//   - Bot's wallet has a BCH-only UTXO ≥ bch_sats + 1000 sat fee
//   - Bot's wallet has a token UTXO ≥ token_base_units (for non-first LP)
//   - For non-first LP: an existing pool for token_id must exist
//
// Output (dry-run):
//   { tx_hash, tx_hex, fee, pool_outpoint, lp_recipient }
//
// What this does:
//   1. For --first: build a tx with [BCH input, token input] → [new pool UTXO].
//      Signs both inputs with our keys. Broadcasts (or dry-runs).
//   2. For non-first (default): pick the largest existing pool for token_id,
//      build a tx that adds our liquidity to it. Requires additional inputs
//      (BCH + token) and constructs pool output with combined reserves.
//      NOT YET IMPLEMENTED — Phase 4 follow-up.

import { connect, scripthashForAddress } from '../lib/network.mjs';
import { connectCauldronRostrum, fetchPools } from '../lib/cauldron.mjs';
import { NATIVE_BCH_TOKEN_ID } from '@cashlab/common';
import {
  loadWallet,
  loadHdNode,
  deriveReceivingAddresses,
  deriveChangeAddresses,
  newChangeAddress,
} from '../lib/wallet.mjs';
import { signP2pkhTransaction } from '../lib/sign.mjs';
import { signCovenantInput, buildCovenantUnlockingBytecode } from '../lib/cashscript.mjs';
import { secp256k1, hash160, encodeCashAddress, CashAddressType } from '@bitauth/libauth';
import { binToHex, hexToBin } from '../lib/hex.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { first: false, broadcast: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--first') out.first = true;
    else if (args[i] === '--broadcast') out.broadcast = true;
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: add-liquidity.mjs <token_id> <bch_sats> <token_amount> [--first] [--broadcast]');
      console.log('Example: add-liquidity.mjs 2469acc5... 1000000 1000000 --first --broadcast');
      process.exit(0);
    } else if (!out.token_id) out.token_id = args[i];
    else if (!out.bch_sats) out.bch_sats = args[i];
    else if (!out.token_amount) out.token_amount = args[i];
  }
  return out;
}

async function findPoolInputForToken(client, token_id) {
  const pools = await fetchPools(client, token_id);
  if (pools.length === 0) return null;
  // Largest pool by token amount (most liquid)
  pools.sort((a, b) => Number(b.output.token.amount - a.output.token.amount));
  return pools[0];
}

async function gatherBchInputs(client, needed_sats) {
  // Find BCH-only UTXOs in the wallet (receiving + change chains).
  const allUtxos = [];
  for (const a of deriveReceivingAddresses(20)) {
    const sh = scripthashForAddress(a.address);
    const utxos = await client.request('blockchain.scripthash.listunspent', sh);
    if (Array.isArray(utxos)) {
      for (const u of utxos) if (!u.token_data && u.height > 0) allUtxos.push({ address: a.address, chain: 'recv', ...u });
    }
  }
  for (const a of deriveChangeAddresses(20)) {
    const sh = scripthashForAddress(a.address);
    const utxos = await client.request('blockchain.scripthash.listunspent', sh);
    if (Array.isArray(utxos)) {
      for (const u of utxos) if (!u.token_data && u.height > 0) allUtxos.push({ address: a.address, chain: 'change', ...u });
    }
  }
  // Largest first, sum until enough
  allUtxos.sort((a, b) => b.value - a.value);
  let total = 0n;
  const selected = [];
  for (const u of allUtxos) {
    selected.push(u);
    total += BigInt(u.value);
    if (total >= needed_sats + 1000n) break;
  }
  return { selected, total };
}

async function gatherTokenInputs(client, token_id, needed_amount) {
  const allUtxos = [];
  for (const a of deriveReceivingAddresses(20)) {
    const sh = scripthashForAddress(a.address);
    const utxos = await client.request('blockchain.scripthash.listunspent', sh);
    if (Array.isArray(utxos)) {
      for (const u of utxos) {
        if (u.token_data?.category === token_id && u.height > 0 && !u.token_data?.nft) {
          allUtxos.push({ address: a.address, chain: 'recv', ...u });
        }
      }
    }
  }
  for (const a of deriveChangeAddresses(20)) {
    const sh = scripthashForAddress(a.address);
    const utxos = await client.request('blockchain.scripthash.listunspent', sh);
    if (Array.isArray(utxos)) {
      for (const u of utxos) {
        if (u.token_data?.category === token_id && u.height > 0 && !u.token_data?.nft) {
          allUtxos.push({ address: a.address, chain: 'change', ...u });
        }
      }
    }
  }
  allUtxos.sort((a, b) => Number(BigInt(b.token_data?.amount || 0) - BigInt(a.token_data?.amount || 0)));
  let total = 0n;
  const selected = [];
  for (const u of allUtxos) {
    selected.push(u);
    total += BigInt(u.token_data.amount);
    if (total >= needed_amount) break;
  }
  return { selected, total };
}

async function main() {
  const opts = parseArgs();
  if (!opts.token_id || !opts.bch_sats || !opts.token_amount) {
    console.error('Usage: add-liquidity.mjs <token_id> <bch_sats> <token_amount> [--first] [--broadcast]');
    process.exit(1);
  }

  const bchSats = BigInt(opts.bch_sats);
  const tokenAmt = BigInt(opts.token_amount);
  console.error(`add-liquidity: ${bchSats} sats BCH + ${tokenAmt} ${opts.token_id.slice(0,16)}...`);
  console.error(`mode: ${opts.first ? 'first-LP (new pool)' : 'add to existing pool'}`);

  const w = loadWallet();
  if (!w) { console.error('no wallet; run create-wallet.mjs first'); process.exit(1); }
  if (w.network !== 'mainnet' && process.env.BCH_WALLET_DIR === undefined) {
    console.error(`wallet is ${w.network}; mainnet only`); process.exit(1);
  }
  console.error(`network: ${w.network}`);

  const { hdNode } = loadHdNode();
  const client = await connect(w.network);
  const cauldronClient = await connectCauldronRostrum();

  try {
    console.error('[1/5] gathering BCH inputs...');
    const bchIn = await gatherBchInputs(client, bchSats);
    if (bchIn.total < bchSats + 1000n) {
      console.error(`   ✗ insufficient BCH: have ${bchIn.total} sat, need ${bchSats + 1000n}`);
      process.exit(1);
    }
    console.error(`   ${bchIn.selected.length} BCH input(s), total ${bchIn.total} sat`);

    console.error('[2/5] gathering token inputs...');
    const tokenIn = await gatherTokenInputs(client, opts.token_id, tokenAmt);
    if (tokenIn.total < tokenAmt) {
      console.error(`   ✗ insufficient token: have ${tokenIn.total}, need ${tokenAmt}`);
      process.exit(1);
    }
    console.error(`   ${tokenIn.selected.length} token input(s), total ${tokenIn.total}`);

    let poolUtxo = null;
    if (!opts.first) {
      console.error('[3/5] finding existing pool...');
      poolUtxo = await findPoolInputForToken(cauldronClient, opts.token_id);
      if (!poolUtxo) {
        console.error('   ✗ no existing pool found. use --first to create one.');
        process.exit(1);
      }
      console.error(`   found pool: ${poolUtxo.outpoint.txhash.slice(0,16)}...:${poolUtxo.outpoint.index}`);
    } else {
      console.error('[3/5] creating new pool (--first)...');
    }

    // Derive the user's pubkey from the wallet for the pool's withdraw address.
    // Use the first receiving address's keypair (simplification — real impl would
    // derive for the right change address index).
    const userRecvAddr = deriveReceivingAddresses(1)[0];
    const { deriveChildPrivKey } = await import('../lib/wallet.mjs');
    const userPrivkey = deriveChildPrivKey(hdNode, 0, 0, 0);
    const userPubkey = secp256k1.derivePublicKeyCompressed(userPrivkey);
    if (typeof userPubkey === 'string') throw new Error('derivePublicKeyCompressed failed');

    const poolLockingBytecode = cauldronClient.constructor // placeholder; will use exlab directly
      ;
    // Actually we need exlab from lib/cauldron.mjs:
    const { exlab } = await import('../lib/cauldron.mjs');
    const userPubkeyHash = hash160(userPubkey);
    const poolBytecode = exlab.generatePoolV0LockingBytecode({ withdraw_pubkey_hash: userPubkeyHash });

    // [4/5] build the tx
    console.error('[4/5] building first-LP tx (2 inputs → 1 pool output)...');
    const feeRateSatPerByte = 1n;
    const estSize = 300n;  // rough estimate for 2 inputs + 1 output
    const fee = estSize * feeRateSatPerByte;
    const bchChange = bchIn.total - bchSats - fee;
    const tokenChange = tokenIn.total - tokenAmt;
    const changeAddr = newChangeAddress();

    if (bchChange < 0n) { console.error('✗ BCH change negative'); process.exit(1); }

    const outputs = [{
      lockingBytecode: poolBytecode,
      valueSatoshis: bchSats,
      token: { amount: tokenAmt, category: hexToBin(opts.token_id) },
    }];
    if (bchChange >= 546n) outputs.push({ address: changeAddr.address, valueSatoshis: bchChange });
    if (tokenChange > 0n) outputs.push({ address: changeAddr.address, valueSatoshis: 1000n, token: { amount: tokenChange, category: hexToBin(opts.token_id) } });

    // Map inputs to signing shape
    const recvAddrs = deriveReceivingAddresses(20);
    const changeAddrs = deriveChangeAddresses(20);
    const inputsForSigning = [];
    for (const u of bchIn.selected) {
      const recvIdx = recvAddrs.findIndex((a) => a.address === u.address);
      const chgIdx = changeAddrs.findIndex((a) => a.address === u.address);
      inputsForSigning.push({
        ...u,
        hdNode, account: 0,
        change: recvIdx >= 0 ? 0 : 1,
        index: recvIdx >= 0 ? recvIdx : chgIdx,
      });
    }
    for (const u of tokenIn.selected) {
      const recvIdx = recvAddrs.findIndex((a) => a.address === u.address);
      const chgIdx = changeAddrs.findIndex((a) => a.address === u.address);
      inputsForSigning.push({
        ...u,
        hdNode, account: 0,
        change: recvIdx >= 0 ? 0 : 1,
        index: recvIdx >= 0 ? recvIdx : chgIdx,
      });
    }

    console.error('[5/5] signing with libauth compiler (P2PKH, 0x41 sighash)...');
    const signed = await signP2pkhTransaction({ inputs: inputsForSigning, outputs });
    console.error(`   txid=${signed.tx_hash}`);
    console.error(`   fee=${signed.fee} sat (actual)`);

    if (!opts.broadcast || process.env.BCH_CONFIRM !== 'yes') {
      console.error('   DRY RUN. set BCH_CONFIRM=yes (with --broadcast) to actually broadcast.');
      console.log(JSON.stringify({
        tx_hash: signed.tx_hash,
        tx_hex: signed.tx_hex,
        fee: signed.fee.toString(),
        bch_added: bchSats.toString(),
        token_added: tokenAmt.toString(),
        token_category: opts.token_id,
        pool_output_script: Buffer.from(poolBytecode).toString('hex').slice(0, 32) + '...',
        dry_run: true,
      }, null, 2));
      return;
    }

    console.error('   BCH_CONFIRM=yes — broadcasting...');
    const result = await client.request('blockchain.transaction.broadcast', signed.tx_hex);
    if (typeof result === 'string' && result.startsWith('Error')) {
      throw new Error(`broadcast rejected: ${result}`);
    }
    console.error(`   broadcast response: ${result}`);
    console.log(JSON.stringify({ tx_hash: signed.tx_hash, broadcast: true, server_response: result }, null, 2));
  } finally {
    await client.disconnect();
    await cauldronClient.disconnect();
  }
}

main().catch((e) => { console.error('error:', e.message); console.error(e.stack); process.exit(1); });