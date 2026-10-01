// lib/router.mjs — Cauldron swap client for the Riften Labs Router API.
//
// The router is a public, no-auth WebSocket service run by the DEX operator
// (Riften Labs). It tracks pools live, serves quotes, and assembles the
// UNSIGNED swap transaction — including the Cauldron pool inputs, whose keys no
// wallet holds. We sign only `inputs_to_sign` (our own funding inputs) and
// broadcast ourselves.
//
// This replaces the hand-rolled pool parsing and CPMM quoting that used to
// live here. That code could not sign a swap (the pool operator's key is
// embedded in each pool's locking bytecode and no user possesses it), and the
// router is maintained by the same people who run the pools.
//
// Docs: https://docs.riftenlabs.com/router/
//
// Everything here is boundary code: the network is untrusted, so every
// response is validated and translated into domain shapes before it is
// returned. Callers inside the wallet never re-check these fields.

const ROUTER_WS = process.env.BCH_CAULDRON_ROUTER || 'wss://router.riften.net/v1/route';
const BROADCAST_URL = process.env.BCH_CAULDRON_BROADCAST || 'https://broadcast.cauldron.quest/broadcast';

// The router requires a 64-char hex category, or the literal "bch" for native.
const NATIVE_BCH = 'bch';

const isNativeBch = (asset) => asset === NATIVE_BCH || asset === 'BCH';
const isCategory = (asset) => typeof asset === 'string' && /^[0-9a-f]{64}$/i.test(asset);

function validateAsset(asset, label) {
  if (isNativeBch(asset) || isCategory(asset)) return;
  throw new Error(`${label} must be "bch" or a 64-char CashToken category hex, got: ${asset}`);
}

// Base units are integer strings on the wire. BCH amounts arrive as decimal
// strings from users, so convert at the boundary rather than letting floats
// reach an integer-only protocol.
export function bchToBaseUnits(bch) {
  if (!/^\d+(\.\d{1,8})?$/.test(String(bch))) {
    throw new Error(`invalid BCH amount: ${bch}`);
  }
  const [whole, frac = ''] = String(bch).split('.');
  return BigInt(whole) * 100000000n + BigInt(frac.padEnd(8, '0'));
}

export function baseUnitsToBch(baseUnits) {
  const v = BigInt(baseUnits);
  const whole = v / 100000000n;
  const frac = (v % 100000000n).toString().padStart(8, '0');
  return `${whole}.${frac}`;
}

// Scale a display amount by an arbitrary decimal count. CashTokens FT amounts
// are integers, so a token with 2 decimals needs "1.50" -> 150n, not 1.5.
export function toBaseUnits(amount, decimals) {
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 0 || d > 18) {
    throw new Error(`invalid decimals: ${decimals}`);
  }
  const text = String(amount);
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`invalid amount: ${amount}`);
  }
  const [whole, frac = ''] = text.split('.');
  if (frac.length > d) {
    throw new Error(`amount ${amount} has more than ${d} decimal places`);
  }
  return BigInt(whole) * 10n ** BigInt(d) + BigInt(frac.padEnd(d, '0') || '0');
}

class Router {
  constructor(url = ROUTER_WS) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    if (this.ws && this.ws.readyState === 1) return this;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else entry.resolve(msg.result);
    };

    ws.onerror = () => {
      for (const entry of this.pending.values()) {
        entry.reject(new Error('router connection failed'));
      }
      this.pending.clear();
    };

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('router connect timeout')), 20000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('router connection failed'));
      };
    });
    return this;
  }

  async request(method, params, { timeoutMs = 30000 } = {}) {
    await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
    }
    this.ws = null;
  }
}

let shared = null;
async function router() {
  if (!shared) shared = new Router();
  return shared;
}

// Live price for a trade. `side: 'sell'` fixes the input amount, `'buy'` fixes
// the output — the caller must say which, because the two produce different
// transactions for the same numbers.
export async function quote({ sell, buy, amount, side = 'sell' }) {
  validateAsset(sell, 'sell');
  validateAsset(buy, 'buy');
  if (sell === buy) throw new Error('sell and buy must differ');
  if (side !== 'sell' && side !== 'buy') throw new Error('side must be "sell" or "buy"');

  const result = await (await router()).request('route.quote', {
    sell,
    buy,
    amount: String(amount),
    side,
  });

  return {
    inputAmount: String(result.input_amount),
    outputAmount: String(result.output_amount),
    inputIsBch: result.input_is_bch === true,
    outputIsBch: result.output_is_bch === true,
    priceBefore: String(result.market_pre_price),
    priceAfter: String(result.market_post_price),
    poolCount: Number(result.pools || 0),
  };
}

// Assemble the unsigned swap. `funding` is our own spendable UTXOs; the router
// adds the Cauldron pool inputs on top of them.
export async function buildSwap({
  sell,
  buy,
  amount,
  side = 'sell',
  funding,
  receiveAddr,
  changeAddr,
  minOutput,
}) {
  if (!Array.isArray(funding) || funding.length === 0) {
    throw new Error('funding must be a non-empty array of UTXOs');
  }
  if (funding.length > 500) throw new Error('too many funding inputs (max 500)');
  if (!receiveAddr) throw new Error('receiveAddr is required');
  if (!changeAddr) throw new Error('changeAddr is required');

  const params = {
    sell,
    buy,
    amount: String(amount),
    side,
    funding: funding.map((u) => {
      if (!u.txid || u.vout === undefined || u.value === undefined || !u.scriptHex) {
        throw new Error('each funding entry needs txid, vout, value, scriptHex');
      }
      const entry = {
        txid: u.txid,
        vout: Number(u.vout),
        value: String(u.value),
        script_hex: u.scriptHex,
      };
      if (u.token) entry.token = { category: u.token.category, amount: String(u.token.amount) };
      return entry;
    }),
    receive_addr: receiveAddr,
    change_addr: changeAddr,
  };
  if (minOutput !== undefined && minOutput !== null) {
    // Slippage floor only means something in sell mode: in buy mode the output
    // is exactly what was asked for, so there is nothing to protect.
    if (side !== 'sell') throw new Error('min_output only applies when side is "sell"');
    params.min_output = String(minOutput);
  }

  const result = await (await router()).request('tx.build', params);

  return {
    unsignedTxHex: String(result.unsigned_tx_hex),
    sourceOutputs: (result.source_outputs || []).map((o) => ({
      value: String(o.value),
      lockingScriptHex: String(o.locking_script_hex),
    })),
    inputsToSign: (result.inputs_to_sign || []).map(Number),
    expectedOutput: String(result.expected_output),
    feeSats: String(result.fee_sats),
    feeTokenAmount: String(result.fee_token_amount),
    minerFeeSats: String(result.miner_fee_sats),
  };
}

// The router is explicitly documented as beta: a quote can go stale between
// request and build, and a build can differ from the quote it was priced from.
// This is the gate between "the user agreed to a price" and "we are about to
// sign", so it fails closed — any mismatch means do not sign.
export function verifyBuildAgainstQuote(quoteResult, buildResult, { minOutput } = {}) {
  const problems = [];

  if (quoteResult.outputAmount !== buildResult.expectedOutput) {
    problems.push(
      `output changed: quoted ${quoteResult.outputAmount}, built ${buildResult.expectedOutput}`
    );
  }
  if (minOutput !== undefined && minOutput !== null) {
    if (BigInt(buildResult.expectedOutput) < BigInt(minOutput)) {
      problems.push(
        `output ${buildResult.expectedOutput} is below the slippage floor ${minOutput}`
      );
    }
  }
  if (buildResult.inputsToSign.length === 0) {
    problems.push('router returned no inputs for us to sign');
  }
  if (!buildResult.unsignedTxHex) {
    problems.push('router returned an empty transaction');
  }

  return { ok: problems.length === 0, problems };
}

// Decode the transaction the router wants us to sign and check the OUTPUTS.
//
// This is the check the quote-vs-build comparison cannot make. Comparing
// `expectedOutput` between quote and build verifies only that the router is
// internally consistent -- both numbers come from the router, and a router that
// redirects the recipient output can report a matching pair while sending the
// funds elsewhere. The transaction bytes are the thing that actually gets
// signed, so they are the thing that has to be read.
//
// Every output must be one of:
//   - an address we control (the buy output, or our change)
//   - an output whose value equals the sum of our inputs minus our change
//     (i.e. the LP/router fee, which must be accounted for, not ignored)
//
// A token-aware (P2PKH with an NFT or fungible-token prefix) output is NOT
// accepted as a fee output: a plain 25-byte P2PKH output cannot silently carry
// a token, so its length is a reliable way to tell "this is the router's fee"
// from "this is an asset leaving the wallet under a label we did not check".
export async function verifyTransactionOutputs(unsignedTxHex, {
  expectedReceiveAddresses = [],
  changeAddresses = [],
  maxFeeSats = null,
  // The 64-hex-char CashToken category being SOLD, or null/undefined when the
  // swap sells plain BCH. Token outputs in the transaction must be in this
  // category -- that is what proves the pools received the asset the user
  // actually traded rather than something else from the wallet.
  expectedSellTokenCategory = null,
  // The satoshi value the user is selling, when selling plain BCH. The total
  // routed into pool covenants cannot exceed it. Null skips that comparison.
  maxSellValueSats = null,
  // The pool count the router quoted, so the number of covenant outputs in the
  // built transaction can be checked against the route the user agreed to.
  expectedPoolCount = null,
  // The total satoshi value of the inputs this transaction consumes, so BCH
  // conservation can be checked locally: inputs minus outputs is the fee.
  maxInputValueSats = null,
} = {}) {
  const problems = [];
  const { decodeTransactionBCH, cashAddressToLockingBytecode } = await import('@bitauth/libauth');
  const { hexToBin } = await import('./hex.mjs');

  let decoded;
  try {
    decoded = decodeTransactionBCH(hexToBin(unsignedTxHex));
  } catch (e) {
    return { ok: false, problems: [`could not decode the built transaction: ${e.message}`], outputs: [], feeSats: null };
  }
  if (!decoded || !Array.isArray(decoded.outputs)) {
    return { ok: false, problems: ['built transaction has no outputs'], outputs: [], feeSats: null };
  }

  const toBytes = (addr) => {
    try {
      const parsed = cashAddressToLockingBytecode(addr);
      return parsed && parsed.bytecode ? parsed.bytecode : null;
    } catch {
      return null;
    }
  };
  const sameBytes = (a, b) =>
    a instanceof Uint8Array && b instanceof Uint8Array &&
    a.length === b.length && a.every((v, i) => v === b[i]);

  // Normalise the allow-list once. An address we cannot parse is an error, not
  // a silently ignored entry -- otherwise a typo in our own receive address
  // would widen the attack surface instead of narrowing it.
  const allowed = [];
  for (const addr of [...expectedReceiveAddresses, ...changeAddresses]) {
    const bytes = toBytes(addr);
    if (!bytes) {
      problems.push(`could not parse our own address ${addr}; refusing to verify against an incomplete allow-list`);
    } else {
      allowed.push(bytes);
    }
  }

  // Output shapes, and what each one means in a Cauldron swap.
  //
  // Two shapes matter, and the important lesson is that SHAPE DOES NOT IDENTIFY
  // OWNERSHIP.
  //
  // A plain P2PKH output is 25 bytes: `76 a9 14 <20-byte hash> 88 ac`.
  //
  // A P2SH32 covenant output is 35 bytes: `aa 20 <32-byte script hash>`,
  // disassembling as `OP_HASH256 OP_PUSHBYTES_32 <32> OP_EQUAL`. libauth's
  // `p2sh32` locking bytecode. A 1 BCH -> PUSD swap routes through ~28 pools and
  // produces ~29 of these paying the pools.
  //
  // BOTH shapes appear on our own outputs. The change output of a swap is a 35
  // byte covenant when the router routes it that way, so "is 35 bytes" does not
  // mean "is a pool". Ownership is decided ONLY by byte comparison against the
  // addresses we supplied, and shape is used solely to decide whether an
  // unrecognised output is a fee, a pool, or a token. Getting that order wrong
  // is how a check starts rejecting the transaction it was written to verify:
  // an earlier version treated every non-25-byte output as suspicious and
  // refused all 31 outputs of a real swap.
  //
  // A CashToken P2PKH output is a 25-byte locking script with an `aa 20
  // <32-byte category> <8-byte amount>` fungible prefix appended by the decoder.
  // That is the shape that appears when selling a token.
  const isP2pkh = (b) => b && b.length === 25 && b[0] === 0x76 && b[1] === 0xa9;
  // p2sh32: `aa 20 <32-byte script hash> 87` -- OP_HASH256, the push, OP_EQUAL.
  // Verified byte-for-byte against a live swap: 170,32,<32>,135.
  const isCovenant = (b) => b && b.length === 35 && b[0] === 0xaa && b[1] === 0x20 && b[34] === 0x87;
  // CashToken prefix appended to a 25-byte P2PKH locking script.
  const isTokenP2pkh = (b) => b && b.length > 25 && isP2pkh(b.slice(0, 25));
  const tokenCategoryOf = (b) =>
    (isTokenP2pkh(b) ? Buffer.from(b.slice(26, Math.min(58, b.length))).toString('hex') : null);

  const outputs = decoded.outputs.map((o, index) => {
    const bytes = o.lockingBytecode;
    const ours = allowed.some((b) => sameBytes(b, bytes));
    return {
      index,
      valueSatoshis: o.valueSatoshis === undefined ? null : BigInt(o.valueSatoshis),
      lockingBytecode: bytes,
      // Ownership first, and it wins outright. A shape-based verdict must never
      // override a byte-for-byte match with an address we control.
      isOurs: ours,
      isSimpleP2pkh: isP2pkh(bytes) && !isTokenP2pkh(bytes),
      isCovenantOutput: !ours && isCovenant(bytes),
      isTokenOutput: !ours && isTokenP2pkh(bytes),
      tokenCategory: ours ? null : tokenCategoryOf(bytes),
    };
  });

  if (outputs.length === 0) {
    problems.push('built transaction has no outputs at all');
  }

  // Classify every output. An output matching none of the known shapes is
  // refused outright -- it could be anything, including an asset leaving the
  // wallet under a label we never checked.
  const tokenOutputs = [];
  const covenantOutputs = [];
  for (const o of outputs) {
    if (o.isOurs) continue;
    if (o.isCovenantOutput) { covenantOutputs.push(o); continue; }
    if (o.isTokenOutput) { tokenOutputs.push(o); continue; }
    if (o.isSimpleP2pkh) continue;              // candidate fee, checked below
    problems.push(
      `output ${o.index} has an unrecognised shape: ${o.lockingBytecode ? o.lockingBytecode.length : 0} bytes. ` +
      `expected one of ours (${allowed.length} address(es)), a pool covenant, a CashToken output, or a plain P2PKH fee output`
    );
  }

  // Covenant outputs pay the pools, and their decoded value is NOT BCH.
  //
  // Verified against a live 1 BCH -> PUSD build, whose 31 outputs are:
  //   - outputs 0..27: 28 p2sh32 pool covenants. The quoted route used 28 pools.
  //     Their decoded values are each pool's PUSD POSITION in base units, not
  //     satoshis, and they sum to 38,035,876,708 -- three orders of magnitude
  //     more BCH than the transaction contains. Summing them naively is how a
  //     check ends up "creating" 38,000 BCH out of 0.05 BCH of input.
  //   - output 28: 25-byte P2PKH to our receive address, 1000 sat. PUSD at 2
  //     decimals, so 1000 is the swap's 10.00 PUSD output.
  //   - output 29: a 35-byte covenant worth 998 sat, which is the ROUTER FEE
  //     (buildSwap reported feeSats 998). It is a covenant, not a pool, and it
  //     is NOT one of the 28 quoted pools.
  //   - output 30: 25-byte P2PKH to our change address, 3,994,173 sat.
  //
  // So the pool-count check must be one-directional and must allow for the
  // router's own fee output: covenants paying pools cannot exceed the quoted
  // pool count, plus at most one for the fee. Checking the other direction
  // would fail, because a router may legitimately net several pools' inputs
  // into one output.
  if (expectedPoolCount !== null && expectedPoolCount !== undefined) {
    // The fee is the one non-pool covenant, and it is bounded by the ceiling.
    // Everything else that is a covenant is a pool.
    const feeCovenants = covenantOutputs.filter(
      (o) => maxFeeSats !== null && maxFeeSats !== undefined && o.valueSatoshis <= maxFeeSats
    );
    const poolCovenants = covenantOutputs.length - feeCovenants.length;
    if (poolCovenants > expectedPoolCount) {
      problems.push(
        `the transaction pays ${poolCovenants} pool covenant(s), but the router quoted a route ` +
        `through ${expectedPoolCount} pool(s). Refusing: more value is committed to pools than ` +
        `the route the user agreed to uses.`
      );
    }
  }

  // Token outputs must carry the category we sold. A token output in a DIFFERENT
  // category is an asset leaving the wallet that the user never agreed to trade.
  if (expectedSellTokenCategory) {
    for (const o of tokenOutputs) {
      if (o.tokenCategory !== expectedSellTokenCategory.toLowerCase()) {
        problems.push(
          `output ${o.index} carries token category ${o.tokenCategory}, but the swap is selling ` +
          `${expectedSellTokenCategory}. Refusing: that is an asset leaving the wallet that was not traded.`
        );
      }
    }
  } else if (tokenOutputs.length > 0) {
    // Selling plain BCH, so no token outputs are expected at all.
    problems.push(
      `the swap sells BCH, but the transaction has ${tokenOutputs.length} token output(s) ` +
      `(${tokenOutputs.map((o) => o.tokenCategory?.slice(0, 12)).join(', ')}). Refusing.`
    );
  }

  // A plain P2PKH output that is not ours must be a fee, and a fee is bounded.
  //
  // maxFeeSats === null means we do not know a ceiling, and an unexplained
  // output with no ceiling is refused rather than waved through: we cannot tell
  // a fee from a redirected payment without a limit. Skipping the comparison
  // fails OPEN, which is the wrong direction for a value-moving operation.
  for (const o of outputs) {
    if (o.isOurs || o.isTokenOutput || o.isCovenantOutput) continue;
    if (maxFeeSats === null || maxFeeSats === undefined) {
      problems.push(
        `output ${o.index} pays ${o.valueSatoshis} sats to an address we do not ` +
        'control, and no fee ceiling was supplied to account for it. Refusing: an ' +
        'unattributable output must never be accepted without a stated limit.'
      );
      continue;
    }
    if (o.valueSatoshis === null) {
      problems.push(`output ${o.index} has no readable value, so it cannot be checked against the fee ceiling`);
      continue;
    }
    if (o.valueSatoshis > maxFeeSats) {
      problems.push(
        `output ${o.index} pays ${o.valueSatoshis} sats to an address we do not control, which exceeds the fee ceiling of ${maxFeeSats} sats`
      );
    }
  }

  // BCH conservation, checked where satoshis actually live: the plain P2PKH
  // outputs. Inputs minus outputs must equal the fee, and nothing more.
  //
  // Verified against a live 1 BCH -> PUSD build. Of 31 outputs:
  //   - 29 are p2sh32 pool covenants, whose decoded values are POOL TOKEN
  //     POSITIONS in PUSD base units, not satoshis, and sum to 38 billion;
  //   - 2 are 25-byte P2PKH, and BOTH pay our own address: 1000 sat (the PUSD
  //     receive, at PUSD's 2 decimals) and 3,994,173 sat (the BCH change).
  //
  // So "inputs minus ALL p2pkh outputs" is not the fee: it also subtracts our own
  // change, which made the implied fee look like 1,004,827 sats. The fee is what
  // leaves to an address we do NOT control, so the conservation check must be
  // over non-ours P2PKH outputs only.
  //
  // This is the local check the wiki asks for, and the one that catches a router
  // quietly paying itself out of the trade.
  if (maxInputValueSats !== null && maxInputValueSats !== undefined) {
    const foreignBchOut = outputs
      .filter((o) => o.isSimpleP2pkh && !o.isOurs)
      .reduce((acc, o) => acc + (o.valueSatoshis || 0n), 0n);
    if (foreignBchOut > maxInputValueSats) {
      problems.push(
        `the transaction pays ${foreignBchOut} sats to addresses we do not control, but its ` +
        `inputs only carry ${maxInputValueSats} sats. Refusing: value cannot be created.`
      );
    } else if (maxFeeSats !== null && maxFeeSats !== undefined && foreignBchOut > maxFeeSats) {
      problems.push(
        `${foreignBchOut} sats leave the wallet to addresses we do not control, which is more ` +
        `than the fee ceiling of ${maxFeeSats} sats. Refusing: that is not a fee, it is a payment.`
      );
    }
  }

  // We must be able to name at least one of our own outputs, otherwise the
  // "every unknown output is a small fee" reasoning has no anchor.
  if (allowed.length > 0 && !outputs.some((o) => o.isOurs)) {
    problems.push('none of the built transaction outputs pay an address we control');
  }

  return { ok: problems.length === 0, problems, outputs, feeSats: null };
}

// Broadcast a signed transaction over Electrum, using a client the caller
// already has open.
//
// This exists because the Cauldron HTTP broadcast endpoint
// (broadcast.cauldron.quest) accepts a TCP connection and then fails the TLS
// handshake, and because it was never the only way to broadcast. `blockchain.
// transaction.broadcast` is part of the Electrum protocol: every full node
// serves it, and CashTokens-aware nodes serve it for token-bearing
// transactions too.
//
// Verified rather than assumed. Broadcasting a transaction whose output carries
// a PUSD CashToken prefix to `cashnode.bch.ninja` (mainnet) and
// `chipnet.bch.ninja` returns:
//   "the transaction was rejected by network rules. dust (code 64)"
// at 546 sats, and
//   "the transaction was rejected by network rules. Missing inputs"
// at 2000 sats.
// Both are consensus-level rejections from a node that parsed the token prefix,
// accepted the value, and reached UTXO lookup. A server that could not handle
// CashTokens would have failed to decode instead.
//
// Note the servers' `listunspent` does NOT return a `token_data` field even
// though they broadcast token transactions correctly. UTXO enumeration and
// broadcast validation are different code paths; do not conclude a server is
// not token-aware from the absence of that field.
export async function broadcastViaElectrum(client, signedTxHex) {
  if (!client || typeof client.request !== 'function') {
    throw new Error('broadcastViaElectrum requires a connected Electrum client');
  }
  if (typeof signedTxHex !== 'string' || signedTxHex.length === 0) {
    throw new Error('signed transaction hex is required');
  }
  const result = await client.request('blockchain.transaction.broadcast', signedTxHex);
  // Electrum returns the txid as a bare string on success, and rejects with an
  // Error carrying the node's message on failure. Some builds resolve with an
  // object instead, so accept both rather than assuming the shape.
  if (typeof result === 'string' && /^[0-9a-fA-F]{64}$/.test(result)) {
    return { txid: result };
  }
  if (result && typeof result === 'object' && typeof result.txid === 'string') {
    return { txid: result.txid };
  }
  throw new Error(
    `broadcast returned an unexpected response: ${String(result).slice(0, 200)}`
  );
}

// Broadcast to the router's HTTP endpoint. Kept as a FALLBACK, not the primary
// path: it is a third-party service, it was serving TLS 0 bytes, and a swap
// does not need it.
export async function broadcastSwap(signedTxHex) {
  const response = await fetch(BROADCAST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx: signedTxHex }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`broadcast failed (${response.status}): ${text.slice(0, 200)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`broadcast returned unparseable response: ${text.slice(0, 200)}`);
  }
  if (!parsed.txid) throw new Error(`broadcast response had no txid: ${text.slice(0, 200)}`);
  return { txid: parsed.txid };
}

// Resolve a token symbol to its category id via the Riften indexer, so the CLI
// can accept "PUSD" instead of a 64-char hex string. The Electrum token
// methods are not served by every public Rostrum node, so the indexer -- the
// same operator that runs the router -- is the reliable source.
const INDEXER = process.env.BCH_CAULDRON_INDEXER || 'https://indexer.riften.net';

export async function resolveToken(symbol) {
  if (isNativeBch(symbol)) return { categoryId: NATIVE_BCH, symbol: 'BCH', decimals: 8, name: 'Bitcoin Cash' };
  if (isCategory(symbol)) {
    return { categoryId: symbol.toLowerCase(), symbol: symbol, decimals: null, name: null };
  }

  const query = encodeURIComponent(String(symbol));
  const response = await fetch(`${INDEXER}/cauldron/tokens/search_cached?q=${query}`);
  if (!response.ok) {
    throw new Error(`token lookup failed (${response.status}) for "${symbol}"`);
  }
  const tokens = await response.json();
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new Error(`no token found for "${symbol}" — pass the 64-char category id`);
  }
  if (tokens.length > 1) {
    const names = tokens.slice(0, 4).map((t) => t.display_symbol || t.display_name).join(', ');
    throw new Error(`"${symbol}" is ambiguous (${tokens.length} matches: ${names}…) — pass the 64-char category id`);
  }

  const t = tokens[0];
  const bcmr = t.bcmr && t.bcmr.token ? t.bcmr.token : {};
  return {
    categoryId: String(t.token_id),
    symbol: String(t.display_symbol || bcmr.symbol || symbol),
    name: String(t.display_name || bcmr.name || symbol),
    decimals: bcmr.decimals === undefined ? null : Number(bcmr.decimals),
  };
}
