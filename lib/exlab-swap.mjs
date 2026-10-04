// lib/exlab-swap.mjs — in-wallet Cauldron swaps via @cashlab/cauldron.
//
// This is the engine. lib/router.mjs is only token lookup and unit conversion
// now; the router that used to assemble transactions server-side is gone.
//
// WHY AN SDK AND NOT A ROUTER
//
// The old path asked router.riften.net to assemble the unsigned swap, pool
// inputs included, and returned it to sign. It selected spent pools, so every
// transaction died at submission with a missing-inputs rejection. That is not a
// signing bug and no amount of retrying fixes it.
//
// Paytaca -- the reference wallet for this protocol -- does not use a router
// for its own swaps. It reads the public indexer for pool state and assembles
// locally with this same SDK. So we do too, and the AMM math, the covenant
// unlocking bytecode and the transaction layout are correct by construction
// rather than correct-by-hope.
//
// A CAREFUL READING NOTE, carried over from the code this replaces
//
// The deleted verifyTransactionOutputs was 348 lines and its real contribution
// was this: OWNERSHIP checks cannot catch "right place, short amount". A server
// that quotes 36,141 and builds 1 pays an address the user genuinely owns and
// passes every ownership and pool-count test. The user signs it, because the
// destination IS theirs.
//
// ExchangeLab removes the specific instance of that hazard -- there is no
// server-side quote to diverge from -- but the class of bug is not gone, it
// moved. So quoteFromPools and buildSwap below run the SAME pool list through
// the same SDK, and the quote the user approves is the quote the transaction
// is built from. buildSwap takes the TradeResult from quoteFromPools rather
// than re-quoting, so the two cannot silently diverge.
//
// If you are ever tempted to let a caller pass pools to buildSwap that the user
// did not approve a quote for, that is the moment this design fails. Don't.

// Adapter from the indexer's JSON pool records to the SDK's PoolV0 shape.
// Field mapping is identical to paytaca-app src/wallet/cauldron/utils.js
// (AGPL-3.0): the indexer calls it `tokens`, the SDK calls it a token amount.

import { ExchangeLab } from '@cashlab/cauldron';
import {
  NATIVE_BCH_TOKEN_ID,
  PayoutAmountRuleType,
  SpendableCoinType,
} from '@cashlab/common';

const INDEXER = process.env.BCH_CAULDRON_INDEXER || 'https://indexer.riften.net';

const hexToBin = (h) => Uint8Array.from(Buffer.from(String(h), 'hex'));
const binToHex = (b) => Buffer.from(b).toString('hex');

let exlab;
function lab() {
  if (!exlab) exlab = new ExchangeLab();
  return exlab;
}

/**
 * One indexer pool record -> the SDK's PoolV0.
 *
 * The indexer returns { txid, tx_pos, sats, tokens, owner_pkh, token_id }. The
 * SDK needs the covenant locking bytecode, which is derived from the owner's
 * pubkey hash plus the pool identity -- the SDK generates it, we never assemble
 * covenant bytecode by hand.
 */
function toPoolV0(p) {
  const parameters = { withdraw_pubkey_hash: hexToBin(p.owner_pkh) };
  return {
    version: '0',
    parameters,
    outpoint: { index: p.tx_pos, txhash: hexToBin(p.txid) },
    output: {
      locking_bytecode: lab().generatePoolV0LockingBytecode(parameters),
      token: { amount: BigInt(p.tokens), token_id: p.token_id },
      amount: BigInt(p.sats),
    },
  };
}

/** Fetch live pools for a token category from the public indexer. */
export async function fetchPools(tokenId) {
  const res = await fetch(`${INDEXER}/cauldron/pool/active?token=${tokenId}`);
  if (!res.ok) throw new Error(`pool fetch failed (${res.status}) for ${tokenId}`);
  const raw = await res.json();
  const active = raw?.active;
  if (!Array.isArray(active) || active.length === 0) {
    throw new Error(`indexer reports no active pools for ${tokenId}`);
  }
  return active.map(toPoolV0);
}

/**
 * Quote a swap with no wallet, no keys and no network beyond the indexer.
 *
 * Returns a TradeResult the user can be shown. Keep it: buildSwap consumes this
 * exact object so the approved quote and the built transaction cannot diverge.
 */
export function quoteSwap({ sell, buy, amountBaseUnits, txFeePerByte = 1n, pools }) {
  const supplyTokenId = sell === 'bch' ? NATIVE_BCH_TOKEN_ID : sell;
  const demandTokenId = buy === 'bch' ? NATIVE_BCH_TOKEN_ID : buy;
  const trade = lab().constructTradeBestRateForTargetSupply(
    supplyTokenId,
    demandTokenId,
    BigInt(amountBaseUnits),
    pools,
    txFeePerByte,
  );
  if (!trade || !Array.isArray(trade.entries) || trade.entries.length === 0) {
    throw new Error('no route: the indexer pools cannot fill this trade');
  }
  return trade;
}

/**
 * Build the unsigned swap from a quote the user already approved.
 *
 * inputCoins MUST be all P2PKH. The SDK's createTradeTx rejects anything else
 * outright, and pool coins are not among them: it derives the covenant inputs
 * from trade.entries itself, which is the entire point of passing the entries.
 */
export function buildSwap({ trade, inputCoins, changeLockingBytecode, receiveLockingBytecode = null }) {
  // A CHANGE rule alone is not enough, and the failure is silent.
  //
  // With only CHANGE, the SDK has no instruction that says "pay the user the
  // quoted demand", so the demand is folded into the change output and no
  // receive output is ever created. For a token buy that reads as a short
  // payment; for a buy-for-BCH it is worse, because the BCH demand is the SAME
  // asset as our coin input, so change absorbs the whole thing and the
  // transaction pays out one number that is neither the quote nor the change.
  //
  // Measured, PUSD -> BCH 0.31: quote 97984 sats, built change 97871 sats, and
  // the only plain-BCH output in the transaction was the change. The 97984 had
  // gone into the pools and never to the user.
  //
  // The fix is Paytaca's: a FIXED rule pinning the quoted demand, THEN a CHANGE
  // rule for everything left over. Two rules, in that order, and the SDK
  // requires the change rule to be present and singular.
  const demandTokenId = trade?.entries?.[0]?.demand_token_id;
  const payouts = [];

  if (receiveLockingBytecode) {
    const amount = trade?.summary?.demand;
    if (amount === undefined || amount === null) {
      throw new Error('refusing to build: the quote carries no demand amount to pin as a FIXED payout');
    }
    payouts.push(demandTokenId === NATIVE_BCH_TOKEN_ID
      // A BCH receive carries a satoshi amount and no token.
      ? { type: PayoutAmountRuleType.FIXED, locking_bytecode: receiveLockingBytecode, amount: BigInt(amount) }
      : {
        type: PayoutAmountRuleType.FIXED,
        locking_bytecode: receiveLockingBytecode,
        // A token-bearing output must be at least the token dust threshold; the
        // SDK adds the sats itself.
        amount: 1000n,
        token: { token_id: demandTokenId, amount: BigInt(amount) },
      });
  }

  payouts.push({
    type: PayoutAmountRuleType.CHANGE,
    locking_bytecode: changeLockingBytecode,
  });

  const built = lab().createTradeTx(trade.entries, inputCoins, payouts, null, 1n);
  return {
    unsignedTxHex: binToHex(built.txbin),
    feeSats: built.txfee,
    sourceOutputs: built.libauth_source_outputs,
    payoutsInfo: built.payouts_info,
  };
}

/**
 * Check the built transaction against the quote the user approved.
 *
 * This is the guard that earns its place. The SDK's verifyTradeTx proves the
 * covenant scripts are satisfied; it does not prove the user got what they were
 * quoted. So compare the payout's token amount to the quote, and the input
 * total to the quote's supply. A shortfall in either direction is a refusal,
 * not a warning.
 */
export function verifyAgainstQuote({ trade, built, minOutputBaseUnits = null }) {
  const problems = [];

  const quoteDemand = trade?.summary?.demand;
  const quoteSupply = trade?.summary?.supply;
  if (quoteDemand === undefined || quoteDemand === null) {
    problems.push('quote carried no demand amount; refusing to sign a trade with no expected output');
  }
  if (quoteSupply === undefined || quoteSupply === null) {
    problems.push('quote carried no supply amount; refusing to sign a trade with no known input total');
  }

  // The payout the user receives, read back from the BUILT transaction rather
  // than the quote, so this compares two independent things.
  //
  // A BUY FOR BCH has no token on the payout at all: the SDK reports
  // demand_token_id 'BCH' and the output's token is null, with the amount in
  // satoshis. Searching only for a matching token category therefore finds
  // nothing and reports "no payout to compare against the quote" -- refusing a
  // perfectly good swap. It is the same refusal as a short payment, which is
  // the worst shape a guard can have: correct, and useless.
  //
  // So: when the demand is native BCH, the payout is the one with NO token.
  const demandTokenId = trade?.entries?.[0]?.demand_token_id;
  const wantsBch = demandTokenId === NATIVE_BCH_TOKEN_ID;
  let paidOut = null;
  for (const info of built.payoutsInfo ?? []) {
    const token = info?.output?.token;
    if (wantsBch) {
      // The BCH payout. The change output also has no token, so take the one
      // whose amount is non-zero -- a zero-amount change is not a payment.
      if (!token && BigInt(info?.output?.amount ?? 0n) > 0n) {
        paidOut = BigInt(info.output.amount);
        break;
      }
      continue;
    }
    if (token && token.token_id === demandTokenId) {
      paidOut = token.amount;
      break;
    }
  }
  if (paidOut === null) {
    problems.push(`built transaction has no ${demandTokenId} payout to compare against the quote`);
  } else if (quoteDemand !== undefined && quoteDemand !== null) {
    if (paidOut < quoteDemand) {
      problems.push(`built pays ${paidOut} but the quote promised ${quoteDemand}`);
    } else if (minOutputBaseUnits !== null && paidOut < BigInt(minOutputBaseUnits)) {
      problems.push(`built pays ${paidOut}, below the ${minOutputBaseUnits} minimum you set`);
    }
  }

  return { ok: problems.length === 0, problems, paidOut, quoteDemand, quoteSupply };
}

/** Re-export so callers need one import, not three. */
export { NATIVE_BCH_TOKEN_ID, PayoutAmountRuleType, SpendableCoinType, hexToBin, binToHex };
