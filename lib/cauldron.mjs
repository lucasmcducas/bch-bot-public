// lib/cauldron.mjs — Cauldron AMM integration primitives (Phase 4)
//
// Pattern from:
//   - @cashlab/cauldron v1.0.3 SDK (npm; source at github.com/hosseinzoda/cashlab)
//   - Selene Wallet CauldronService (gitlab.com/selene.cash/selene-wallet, src/kernel/bch/CauldronService.ts)
//
// Cauldron is a micro-pool AMM DEX on BCH (Riften Labs). Each pool is a single UTXO
// holding both sides of a BCH/token pair. Trades spend the pool UTXO and recreate
// it with adjusted amounts per the constant-product (x*y=k) formula.
//
// The bot supports three operations:
//   1. SWAP: spend BCH or token, receive the other side. Uses the pool's operator key
//      (which we don't have). Per the wiki, this is not directly executable from our bot;
//      real swaps go through Cauldron's own trading interface.
//   2. ADD LIQUIDITY: spend BCH + token into the pool's locking bytecode, creating a new
//      pool UTXO. Signable from our bot's wallet — we own the inputs.
//   3. REMOVE LIQUIDITY: spend our LP receipt NFT, get back proportional BCH + token.
//
// The Cauldron rostrum endpoint (rostrum.cauldron.quest:50004) uses protocol "1.4.3"
// (CashTokens-aware) — different from the mainnet 1.5. Use connectCauldronRostrum().

import { ElectrumClient } from '@electrum-cash/network';
import { ExchangeLab } from '@cashlab/cauldron';
import {
  NATIVE_BCH_TOKEN_ID,
  PayoutAmountRuleType,
  SpendableCoinType,
} from '@cashlab/common';
import { hash160, secp256k1, encodeCashAddress, CashAddressType } from '@bitauth/libauth';

import { hexToBin, binToHex } from './hex.mjs';

const CAULDRON_ROSTRUM = 'rostrum.cauldron.quest:50004';
const CAULDRON_PROTOCOL = '1.4.3';

const exlab = new ExchangeLab();
export { exlab };

// Sentinel for native BCH in pool queries (per @cashlab/common/constants)
export const BCH_TOKEN = NATIVE_BCH_TOKEN_ID; // 'BCH'

/**
 * Connect to Cauldron's Rostrum server (uses protocol 1.4.3, not 1.5).
 */
export async function connectCauldronRostrum() {
  const [host, portStr] = CAULDRON_ROSTRUM.split(':');
  const port = parseInt(portStr, 10);
  const client = new ElectrumClient('bch-bot-cauldron', CAULDRON_PROTOCOL, host, { port });
  await client.connect();
  return client;
}

/**
 * Parse a Cauldron rostrum `cauldron.contract.subscribe` response into the
 * PoolV0[] shape the SDK expects.
 *
 * Rostrum returns:
 *   { type: "initial", utxos: [{new_utxo_hash, new_utxo_n, new_utxo_txid, pkh, sats, spent_*, token_id, token_amount, is_withdrawn}] }
 *
 * Pattern: Selene's parsePoolFromRostrumNodeData (CauldronService.ts:38).
 *
 * @param {object} rnResult - response from cauldron.contract.subscribe
 * @returns {Array} array of PoolV0 objects the SDK consumes
 */
export function parsePoolsFromRostrum(rnResult) {
  if (!rnResult || !Array.isArray(rnResult.utxos)) return [];
  const pools = [];
  for (const rn of rnResult.utxos) {
    if (rn.is_withdrawn) continue;
    const pkh = hexToBin(rn.pkh);
    const params = { withdraw_pubkey_hash: pkh };
    const locking_bytecode = exlab.generatePoolV0LockingBytecode(params);
    pools.push({
      version: '0',
      parameters: params,
      outpoint: {
        index: rn.new_utxo_n,
        txhash: hexToBin(rn.new_utxo_txid),
      },
      output: {
        lockingBytecode: locking_bytecode,
        token: {
          amount: BigInt(rn.token_amount),
          token_id: rn.token_id,
        },
        amount: BigInt(rn.sats),
      },
    });
  }
  return pools;
}

/**
 * Fetch all live pools for a given token category from Cauldron's rostrum.
 *
 * @param {ElectrumClient} client
 * @param {string} token_id - token category id (64-char hex)
 * @returns {Promise<Array>} array of PoolV0 objects
 */
export async function fetchPools(client, token_id) {
  const result = await client.request('cauldron.contract.subscribe', 2, token_id);
  return parsePoolsFromRostrum(result);
}

/**
 * Get the current price for a token in sats per token base unit.
 * Sum across all pools (weighted by token amount).
 * Per Selene's CauldronService.getTokenPrice.
 */
export function getTokenPrice(pools, token_id) {
  const relevant = pools.filter((p) => p.output.token.token_id === token_id);
  if (relevant.length === 0) return 0n;
  const tokenSum = relevant.reduce((s, p) => s + p.output.token.amount, 0n);
  const satsSum = relevant.reduce((s, p) => s + p.output.amount, 0n);
  if (satsSum === 0n || tokenSum === 0n) return 0n;
  // Round to nearest integer (sats per token base unit)
  const q = satsSum / tokenSum;
  const r = satsSum % tokenSum;
  return r * 2n >= tokenSum ? q + 1n : q;
}

/**
 * Build an unsigned SWAP tx. Sells `supply_amount` of supply_token to receive demand_token.
 *
 * IMPORTANT: The bot CANNOT broadcast a swap because the POOL is owned by someone else
 * (the pool operator whose pubkey hash is in the pool's locking bytecode). The bot would
 * need that operator's private key to sign input[0]. This function exists for QUERYING
 * swap economics (price, slippage, route), not for actual execution.
 *
 * For real swaps, users go through Cauldron's frontend (cauldron.quest) which orchestrates
 * signing with the right keys. The bot's role here is: "given a swap intent, what's the
 * expected output amount and fee?"
 *
 * @param {object} args
 * @param {string} args.supply_token_id
 * @param {string} args.demand_token_id
 * @param {bigint} args.supply_amount
 * @param {Array} args.pools
 * @param {bigint} args.txfee_per_byte
 * @returns {object|null} TradeResult or null if no route
 */
export function quoteSwap({ supply_token_id, demand_token_id, supply_amount, pools, txfee_per_byte = 1n }) {
  const trade = exlab.constructTradeBestRateForTargetSupply(
    supply_token_id,
    demand_token_id,
    supply_amount,
    pools,
    txfee_per_byte,
  );
  if (!trade || !trade.entries || trade.entries.length === 0) return null;
  return trade;
}

/**
 * Compute the BCH→token or token→BCH trade result for a target demand amount.
 * Returns the supply amount needed to receive `demand_amount` of demand_token.
 */
export function quoteSwapForDemand({ supply_token_id, demand_token_id, demand_amount, pools, txfee_per_byte = 1n }) {
  return exlab.constructTradeBestRateForTargetDemand(
    supply_token_id,
    demand_token_id,
    demand_amount,
    pools,
    txfee_per_byte,
  );
}

/**
 * Build the unsigned tx for ADDING LIQUIDITY to a pool.
 *
 * Strategy: spend our BCH UTXO + our token UTXO into the pool's locking bytecode.
 * Result: a new pool UTXO (with combined reserves) + an LP NFT receipt + change.
 *
 * Per the Cauldron PoolV0 design, the LP receipt is an NFT whose commitment encodes
 * the LP's share. The pool's reserve invariant is preserved: new_reserve_bch * new_reserve_token
 * ≈ old_reserve_bch * old_reserve_token + liquidity_added.
 *
 * IMPORTANT: This is the operation the BOT can sign (we own the inputs). The pool itself
 * is recreated in our tx — we add liquidity, then become an LP holding the receipt NFT.
 *
 * For first liquidity (no existing pool): create a brand-new pool with our BCH + token.
 *
 * NOTE: This function builds the tx structure; lib/sign.mjs handles the actual signing.
 *
 * @param {object} args
 * @param {string} args.token_id
 * @param {bigint} args.bch_amount - sats to add
 * @param {bigint} args.token_amount - token base units to add
 * @param {Array} args.existing_pools - the pool we're adding to (or empty for first LP)
 * @param {string} args.user_address - cashaddr (LP receives receipt NFT)
 * @param {Uint8Array} args.user_pubkey - 33-byte compressed pubkey for signing
 * @returns {object} tx structure ready for signing
 */
export function buildAddLiquidityTx({ token_id, bch_amount, token_amount, existing_pools, user_address, user_pubkey }) {
  // For first-time LP (no existing pool): just create a pool with our liquidity.
  // For subsequent LP (pool exists): spend the existing pool + add our liquidity.
  if (existing_pools.length === 0) {
    // First LP: build a tx with two inputs (BCH + token) and one output (pool UTXO).
    return {
      description: 'Cauldron first-LP (create new pool)',
      inputs: [
        { type: 'bch', value: bch_amount },
        { type: 'token', value: token_amount, token_id },
      ],
      outputs: [{
        type: 'pool',
        lockingBytecode: exlab.generatePoolV0LockingBytecode({
          withdraw_pubkey_hash: hash160(user_pubkey),
        }),
        amount: bch_amount,
        token: { amount: token_amount, token_id },
      }],
      lp_recipient: user_address,
    };
  }
  // Subsequent LP: more complex; deferred for Phase 4 follow-up
  throw new Error('subsequent-LP tx builder not yet implemented (Phase 4 follow-up)');
}

/**
 * Build the unsigned tx for SWAP execution. The bot cannot sign this (pool operator
 * owns the pool's input), but we expose the function for completeness and so other
 * tools can use the same exchange-lab.
 */
export function buildSwapExecutionTx({ supply_token_id, demand_token_id, supply_amount, pools, user_payout_address, user_pubkey, txfee_per_byte = 1n }) {
  // Find best route
  const trade = exlab.constructTradeBestRateForTargetSupply(
    supply_token_id, demand_token_id, supply_amount, pools, txfee_per_byte,
  );
  if (!trade) throw new Error('no swap route found');

  // Build spendable coins: the pool(s) being spent. We don't have their keys.
  // For a real swap, the pool operator (or a relayer) would sign these inputs.
  const spendableCoins = trade.entries.map((entry) => ({
    type: SpendableCoinType.P2PKH,
    key: new Uint8Array(32), // placeholder — operator's key required
    output: {
      locking_bytecode: entry.pool.output.lockingBytecode,
      token: entry.pool.output.token,
      amount: entry.pool.output.amount,
    },
  }));

  // Build payout rules: receive demand tokens at the user's address, BCH change back
  const userPubkeyHash = hash160(user_pubkey);
  const payoutRules = [
    {
      type: PayoutAmountRuleType.FIXED,
      locking_bytecode: exlab.generatePoolV0LockingBytecode({
        withdraw_pubkey_hash: userPubkeyHash,
      }),
      amount: trade.summary.demand,
      token: demand_token_id === NATIVE_BCH_TOKEN_ID ? undefined : {
        token_id: demand_token_id,
        amount: trade.summary.demand,
      },
    },
    {
      type: PayoutRuleType.CHANGE,
      locking_bytecode: exlab.generatePoolV0LockingBytecode({
        withdraw_pubkey_hash: userPubkeyHash,
      }),
      allow_mixing_native_and_token_when_bch_change_is_dust: true,
    },
  ];

  const txResult = exlab.createTradeTx(
    trade.entries,
    spendableCoins,
    payoutRules,
    null,
    txfee_per_byte,
  );
  exlab.verifyTradeTx(txResult);
  return { trade, txResult };
}

export { CAULDRON_ROSTRUM, CAULDRON_PROTOCOL };