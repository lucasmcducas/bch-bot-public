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
