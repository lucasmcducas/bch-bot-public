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

import { hexToBin } from './hex.mjs'
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
// ---------------------------------------------------------------------------
// Token data normalisation across server implementations
// ---------------------------------------------------------------------------
//
// `blockchain.scripthash.listunspent` does not have one field name for tokens.
// Measured on 2026-10-02 against the wallet's own address:
//
//   cashnode.bch.ninja      -> no token fields on this code path
//   rostrum.cauldron.quest  -> has_token, token_id, token_amount, token_bitfield
//
// Rostrum reported the wallet's confirmed 1 ROACH exactly like this:
//
//   { "has_token": true, "token_id": "892cef80…ff53", "token_amount": 100,
//     "token_bitfield": 16, "value": 1000, "tx_hash": "11f1d669…", "tx_pos": 0 }
//
// Every consumer here (balance.mjs, send-token.mjs, sumFtBalances,
// utxoToTokenPrefix, selectTokenUtxos) reads `token_data.{amount,category}`.
// Against the Rostrum shape all of them read `undefined`, so the wallet reported
// zero tokens while holding them. Normalise at the boundary so no consumer has
// to know which server answered.
//
// token_bitfield layout is from the CashTokens spec (cashtokens/cashtokens
// readme, PREFIX_TOKEN): high nibble is prefix_structure, low nibble is the NFT
// capability.
//   0x80 RESERVED_BIT          must be unset
//   0x40 HAS_COMMITMENT_LENGTH prefix carries a commitment
//   0x20 HAS_NFT               prefix carries a non-fungible token
//   0x10 HAS_AMOUNT            prefix carries a fungible amount
//   0x0f nft_capability: 0 immutable, 1 mutable, 2 minting, >2 reserved
// The ROACH UTXO reports 16 = 0b00010000 = HAS_AMOUNT only, i.e. fungible.
const TOKEN_BITFIELD_HAS_AMOUNT = 0x10;
const TOKEN_BITFIELD_HAS_NFT = 0x20;
const TOKEN_BITFIELD_NFT_CAPABILITY = 0x0f;
const TOKEN_CAPABILITY_NAMES = ['none', 'mutable', 'minting'];

/**
 * Normalise one UTXO so a token is always described by `token_data`.
 *
 * Accepts either an already-normalised entry (`token_data`) or a Rostrum entry
 * (`has_token`/`token_id`/`token_amount`/`token_bitfield`). Returns the entry
 * with `token_data` set, or the entry untouched when it carries no token.
 *
 * Deliberately conservative: when `has_token` is true but `token_bitfield` is
 * absent, we cannot tell an NFT from a fungible token, and inventing an amount
 * would fabricate a balance. The entry is left un-normalised so consumers treat
 * it as token-free, which under-reports rather than over-reports.
 *
 * @param {object} utxo
 * @returns {object}
 */
export function normaliseTokenData(utxo) {
  if (!utxo || typeof utxo !== 'object') return utxo;
  if (utxo.token_data) return utxo;              // already normalised
  if (utxo.has_token !== true) return utxo;     // genuinely token-free
  if (typeof utxo.token_bitfield !== 'number') return utxo;
  if (!utxo.token_id) return utxo;              // no category to attach it to

  const bitfield = utxo.token_bitfield;
  const hasAmount = (bitfield & TOKEN_BITFIELD_HAS_AMOUNT) !== 0;
  const hasNft = (bitfield & TOKEN_BITFIELD_HAS_NFT) !== 0;
  if (!hasAmount && !hasNft) return utxo;       // nothing actually encoded

  utxo.token_data = {
    category: utxo.token_id,
    amount: hasAmount ? String(utxo.token_amount ?? 0) : '0',
    ...(hasNft
      ? {
          nft: {
            // Clamp reserved capability values: passing one libauth does not
            // know would fail deep inside the encoder, far from the cause.
            capability:
              TOKEN_CAPABILITY_NAMES[bitfield & TOKEN_BITFIELD_NFT_CAPABILITY] ?? 'none',
            commitment: utxo.token_commitment ?? '',
          },
        }
      : {}),
  };
  return utxo;
}

/**
 * Normalise a list of UTXOs. Idempotent, and passes non-arrays straight through
 * so a node returning a string error does not get mangled.
 *
 * @param {Array<object>} utxos
 * @returns {Array<object>}
 */
export function normaliseTokenDataList(utxos) {
  if (!Array.isArray(utxos)) return utxos;
  return utxos.map(normaliseTokenData);
}
