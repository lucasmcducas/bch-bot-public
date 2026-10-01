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

  const P2PKH_LEN = 25;
  const outputs = decoded.outputs.map((o, index) => ({
    index,
    valueSatoshis: o.valueSatoshis === undefined ? null : BigInt(o.valueSatoshis),
    lockingBytecode: o.lockingBytecode,
    isOurs: allowed.some((b) => sameBytes(b, o.lockingBytecode)),
    isSimpleP2pkh: o.lockingBytecode && o.lockingBytecode.length === P2PKH_LEN,
  }));

  if (outputs.length === 0) {
    problems.push('built transaction has no outputs at all');
  }

  // Every output must be ours, or be a plain (non-token) output we account for
  // as fee. Anything else is an unattributable destination.
  for (const o of outputs) {
    if (o.isOurs) continue;
    if (!o.isSimpleP2pkh) {
      problems.push(
        `output ${o.index} is neither one of our addresses nor a plain P2PKH output: it has ${o.lockingBytecode ? o.lockingBytecode.length : 0} bytes, so it may carry a token`
      );
      continue;
    }
    if (maxFeeSats !== null && o.valueSatoshis !== null && o.valueSatoshis > maxFeeSats) {
      problems.push(
        `output ${o.index} pays ${o.valueSatoshis} sats to an address we do not control, which exceeds the fee ceiling of ${maxFeeSats} sats`
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
