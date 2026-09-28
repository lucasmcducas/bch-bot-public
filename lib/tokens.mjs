// lib/tokens.mjs — CashTokens primitives (UTXO → token prefix mapping, FT sums, dust)
//
// Pattern from Selene Wallet (gitlab.com/selene.cash/selene-wallet):
//   - src/util/normalize.ts :: utxoToTokenPrefix — Electrum UTXO → libauth token prefix
//   - src/kernel/bch/TransactionBuilderService.ts :: createTokenOutput — output construction
//
// Library type references (libauth v3.0.0, verified 2026-09-17):
//   - token prefix shape: { category: Uint8Array(32), amount: bigint, nft?: {capability, commitment} }
//   - capability string: 'none' | 'mutable' | 'minting'
//   - commitment: Uint8Array (empty Uint8Array for FT-only outputs)

import {
  getDustThreshold,
} from '@bitauth/libauth';

import { hexToBin, binToHex } from './hex.mjs';
import { addressToLockingBytecode } from './sign.mjs';

const DUST_RELAY_FEE = 1000n; // 1 sat/byte (BCH standard)

/**
 * Map an Electrum UTXO (from Rostrum `blockchain.scripthash.listunspent`) to the
 * libauth token-prefix shape used in unlocking-bytecode `token:` fields.
 *
 * Selene reference: src/util/normalize.ts :: utxoToTokenPrefix
 *
 * @param {object} utxo - { tx_hash, tx_pos, value, token_data?: {amount, category, nft?} }
 * @returns {object | undefined} - undefined for plain BCH UTXOs
 */
export function utxoToTokenPrefix(utxo) {
  if (!utxo.token_data) return undefined;
  const { amount, category, nft } = utxo.token_data;
  return {
    category: hexToBin(category),
    amount: BigInt(amount),
    nft: !nft
      ? undefined
      : {
          capability: nft.capability, // 'none' | 'mutable' | 'minting'
          commitment: nft.commitment ? hexToBin(nft.commitment) : new Uint8Array(0),
        },
  };
}

/**
 * Build a libauth output object for a token-bearing output.
 * Pattern from Selene's createTokenOutput (TransactionBuilderService.ts:89).
 *
 * Bumps sat amount to dust threshold if recipient didn't specify.
 *
 * @param {object} args
 * @param {string} args.address - recipient cashaddr
 * @param {string} args.category - 32-byte category id (hex)
 * @param {bigint} args.amount - FT amount in base units
 * @param {bigint} [args.satsAmount=1000n] - dust-floor sats for the output
 * @returns {{lockingBytecode: Uint8Array, valueSatoshis: bigint, token: {category, amount}}}
 */
export function createTokenOutput({ address, category, amount, satsAmount = 1000n }) {
  const output = {
    lockingBytecode: addressToLockingBytecode(address),
    valueSatoshis: satsAmount,
    token: {
      category: hexToBin(category),
      amount: typeof amount === 'bigint' ? amount : BigInt(amount),
    },
  };
  const dustThreshold = getDustThreshold(output, DUST_RELAY_FEE);
  if (satsAmount < dustThreshold) {
    output.valueSatoshis = dustThreshold;
  }
  return output;
}

/**
 * Build an NFT output (no fungible amount, just the NFT commitment).
 *
 * @param {object} args
 * @param {string} args.address
 * @param {string} args.category - 32-byte category id (hex)
 * @param {'none'|'mutable'|'minting'} args.capability
 * @param {string} [args.commitment=''] - 32-byte commitment (hex); empty for none
 * @param {bigint} [args.satsAmount=1000n]
 */
export function createNftOutput({ address, category, capability, commitment = '', satsAmount = 1000n }) {
  const output = {
    lockingBytecode: addressToLockingBytecode(address),
    valueSatoshis: satsAmount,
    token: {
      category: hexToBin(category),
      amount: 0n,
      nft: {
        capability,
        commitment: hexToBin(commitment || '00'.repeat(32)),
      },
    },
  };
  const dustThreshold = getDustThreshold(output, DUST_RELAY_FEE);
  if (satsAmount < dustThreshold) output.valueSatoshis = dustThreshold;
  return output;
}

/**
 * Sum fungible token amounts grouped by category id.
 * Skips UTXOs without token_data; skips NFTs (nft !== undefined) when `ftOnly` is true.
 *
 * @param {Array} utxos - Electrum listunspent response items
 * @returns {Map<string, bigint>} - category → total amount (base units)
 */
export function sumFtBalances(utxos, { ftOnly = true } = {}) {
  const out = new Map();
  for (const u of utxos) {
    if (!u.token_data?.amount || !u.token_data.category) continue;
    if (ftOnly && u.token_data.nft) continue;
    const cur = out.get(u.token_data.category) ?? 0n;
    out.set(u.token_data.category, cur + BigInt(u.token_data.amount));
  }
  return out;
}

/**
 * Select token UTXOs by category, largest-FT-first, summing to >= target.
 * Returns the chosen UTXOs (subset of input) and total amount.
 *
 * @param {Array} utxos - Electrum listunspent response items
 * @param {string} category - 32-byte category id (hex) to filter by
 * @param {bigint} target - required FT amount in base units
 * @returns {{selected: Array, total: bigint} | null} - null if insufficient
 */
export function selectTokenUtxos(utxos, category, target) {
  const candidates = utxos
    .filter((u) => u.token_data?.category === category && u.token_data?.amount)
    .map((u) => ({ utxo: u, amount: BigInt(u.token_data.amount) }))
    .sort((a, b) => Number(b.amount - a.amount));
  const selected = [];
  let total = 0n;
  for (const c of candidates) {
    selected.push(c.utxo);
    total += c.amount;
    if (total >= target) break;
  }
  if (total < target) return null;
  return { selected, total };
}

/**
 * Build a token-aware P2PKH send input list — combines FT inputs (selected to cover
 * the FT amount) with BCH-only coin inputs (selected to cover sat output + fee).
 *
 * @param {object} args
 * @param {Array} args.allUtxos - all wallet UTXOs
 * @param {string} args.category - category to spend (hex)
 * @param {bigint} args.tokenAmount - FT amount to send
 * @param {bigint} args.bchRequired - total BCH needed for outputs + fee
 * @returns {{inputs: Array, ftTotal: bigint, bchTotal: bigint}}
 */
export function selectInputsForTokenSend({ allUtxos, category, tokenAmount, bchRequired }) {
  const ft = selectTokenUtxos(allUtxos, category, tokenAmount);
  if (!ft) {
    throw new Error(`insufficient FT balance for category ${category.slice(0, 12)}...`);
  }

  // BCH inputs: prefer BCH-only UTXOs that aren't carrying tokens (avoids
  // accidentally spending a token UTXO into fee). Largest first.
  const bchOnly = allUtxos
    .filter((u) => !u.token_data)
    .sort((a, b) => b.value - a.value);
  const bchSelected = [];
  let bchTotal = 0n;
  for (const u of bchOnly) {
    bchSelected.push(u);
    bchTotal += BigInt(u.value);
    if (bchTotal >= bchRequired + 1000n) break;
  }
  if (bchTotal < bchRequired) {
    throw new Error(`insufficient BCH: have ${bchTotal} sats, need ${bchRequired}`);
  }

  return {
    inputs: [...ft.selected, ...bchSelected],
    ftTotal: ft.total,
    bchTotal,
  };
}

export { DUST_RELAY_FEE };