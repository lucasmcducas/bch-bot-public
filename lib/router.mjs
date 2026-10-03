// lib/router.mjs — token resolution and unit conversion for Cauldron swaps.
//
// HISTORY, because deleting code loses its reasoning unless the reasoning moves
// with it.
//
// This file used to be the Riften Labs Router client. The router assembled the
// unsigned swap server-side, including the Cauldron pool inputs, and handed the
// whole thing back to sign. That is a reasonable design, and it is also exactly
// why every swap died: the pools it selected were spent, and a transaction
// naming a spent outpoint is rejected by the network no matter who signs it.
//
// The replacement is @cashlab/cauldron (ExchangeLab), which is how Paytaca --
// the reference wallet for this protocol -- does its own in-wallet swaps. It
// reads the public indexer for pool state and assembles locally, so the AMM
// math, the covenant unlocking bytecode and the transaction layout are correct
// by construction. There is no router, and therefore nothing to trust.
//
// WHAT WAS DELETED, AND WHY NOTHING WAS KEPT "FOR SAFETY"
//
// verifyTransactionOutputs was 348 lines with careful argument documentation,
// and it looked like a safety net worth preserving. It was not, and the reason
// belongs here so nobody rebuilds it:
//
//   It answers "did the server build what it quoted?" Its arguments are
//   expectedPoolCount and expectedReceiveAmount, both taken from the router's
//   own quote. Its entire threat model is a server that quotes one thing and
//   builds another.
//
//   With ExchangeLab there is no server-side quote. Quoting and building run
//   against the same local pool state, so that hazard does not exist, and the
//   SDK ships verifyTradeTx to check its own output.
//
//   The one part of that reasoning worth keeping is the observation that
//   OWNERSHIP checks cannot catch "right place, short amount" -- a router that
//   quotes 36,141 and builds 1 pays a genuine address the user owns and passes
//   every ownership test. That lesson is recorded on lib/exlab-swap.mjs, where
//   the new engine wraps the SDK.
//
// resolveToken stays: it already queries the public indexer, refuses on an
// ambiguous symbol rather than guessing, and nothing replaces it. The unit
// helpers stay because they are the boundary between the decimal strings users
// type and the integer base units the protocol speaks.

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

