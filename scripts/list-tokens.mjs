#!/usr/bin/env node
// scripts/list-tokens.mjs — what can this wallet actually trade?
//
// Usage:
//   node scripts/list-tokens.mjs            # tokens with a live Cauldron market
//   node scripts/list-tokens.mjs --json     # machine-readable
//   node scripts/list-tokens.mjs --pools pusd
//
// WHY THIS EXISTS
//
// A swap needs two things named before it can be attempted, and until now the
// only way to learn either was to already know them:
//
//   - a symbol or 64-char category, because that is what `swap` takes
//   - whether the pair has a market at all, because Cauldron pools are all
//     BCH/token and a token/token trade is refused
//
// So the wallet could execute a swap and could not tell you what it could swap.
// The indexer already knows, from the same call `swap` makes, and 39 of 40
// tokens on the first probe carried real TVL.
//
// A market row is only useful with a LIQUIDITY number. "PUSD" alone does not say
// whether a trade will route; 388 BCH against 12.2M PUSD does, and it is the
// difference between a quote that fills and one that comes back with no route.

const INDEXER = process.env.BCH_CAULDRON_INDEXER || 'https://indexer.riften.net';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const poolIdx = argv.indexOf('--pools');
const poolFor = poolIdx !== -1 ? argv[poolIdx + 1] : null;

/** indexer token list -> what a human needs to decide whether to swap. */
function row(t) {
  const bc = t.bcmr || {};
  const tok = bc.token || {};
  return {
    symbol: t.display_symbol || tok.symbol || (t.token_id || '').slice(0, 8),
    name: t.display_name || bc.name || null,
    category: t.token_id || tok.category || null,
    decimals: tok.decimals === undefined ? null : Number(tok.decimals),
    price_usd: t.price_now_usd ?? t.price_now ?? null,
    price_bch: t.price_now ?? null,
    tvl_sats: t.tvl_sats ?? 0,
    tvl_tokens: t.tvl_tokens ?? null,
    trade_count: t.trade_count ?? 0,
    trade_volume: t.trade_volume ?? null,
    change_24h_bp: t.change_24h_bp ?? null,
    // THOUSANDS of a token, in display units, so a row is readable without
    // knowing the token's decimals.
    tvl_display: (() => {
      const d = tok.decimals === undefined ? 0 : Number(tok.decimals);
      if (!t.tvl_tokens || d === 0) return t.tvl_tokens ? String(t.tvl_tokens) : null;
      const v = BigInt(Math.round(t.tvl_tokens));
      const div = 10n ** BigInt(d);
      return `${v / div}.${(v % div).toString().padStart(d, '0')}`;
    })(),
  };
}

async function fetchJson(path) {
  const res = await fetch(`${INDEXER}/cauldron/${path}`);
  if (!res.ok) throw new Error(`indexer ${path} -> ${res.status}`);
  return res.json();
}

if (poolFor) {
  // One token's pools in detail: the route surface for a pair.
  const cat = poolFor.length === 64
    ? poolFor
    : (await fetchJson(`tokens/search_cached?q=${encodeURIComponent(poolFor)}`))[0]?.token_id;
  if (!cat) { console.error(`no token found for "${poolFor}"`); process.exit(1); }
  const pools = (await fetchJson(`pool/active?token=${cat}`)).active;
  if (asJson) { console.log(JSON.stringify({ category: cat, pools }, null, 2)); process.exit(0); }
  console.log(`\n  ${pools.length} active pools for ${cat.slice(0, 12)}…\n`);
  const byParent = new Map();
  for (const p of pools) {
    if (!byParent.has(p.txid)) byParent.set(p.txid, []);
    byParent.get(p.txid).push(p);
  }
  for (const [txid, ps] of [...byParent.entries()]
    .sort((a, b) => b[1].reduce((s, p) => s + p.sats, 0) - a[1].reduce((s, p) => s + p.sats, 0))) {
    const sats = ps.reduce((s, p) => s + p.sats, 0);
    const toks = ps.reduce((s, p) => s + p.tokens, 0);
    console.log(`  ${String(ps.length).padStart(3)} outputs  ${(sats / 1e8).toFixed(4).padStart(10)} BCH  ${String(toks).padStart(12)} tok   ${txid.slice(0, 20)}…`);
  }
  console.log();
  process.exit(0);
}

// 500, not 100. The indexer's default page is ordered by SCORE, and a 100-row
// page tops out at 0.02 BCH -- so the three deepest markets in existence, NWB at
// 408 BCH, PUSD at 388 and OLA at 173, were all off the end of the list. The
// whole point of the command is to show what is liquid, and the first version
// showed the opposite: 100 tokens, none of them tradeable at size.
const list = await fetchJson('tokens/list_cached?limit=500');
// The indexer returns by SCORE, which is not liquidity: the first run of this
// command opened with eleven tokens holding 0.0000-0.0003 BCH while PUSD, with
// 388 BCH, sat far below the fold. A list sorted worst-first is a list nobody
// reads, so sort by the number a swap actually depends on.
const rows = list.map(row).filter((r) => r.category && r.tvl_sats > 0)
  .sort((a, b) => b.tvl_sats - a.tvl_sats);

// --search QUERY: filter by symbol, name, or category prefix. The panel needs
// this because showing only the top N tokens makes every other token
// unreachable, and a wallet that can list 20 markets but not find the one you
// hold is a wallet you go around. Matching is case-insensitive and substring,
// so "roach", "ROACH" and a category prefix all find the same token.
const searchIdx = argv.indexOf('--search');
const query = searchIdx !== -1 ? String(argv[searchIdx + 1] || '').trim().toLowerCase() : '';

let out = rows;
if (query) {
  out = rows.filter((r) =>
    String(r.symbol || '').toLowerCase().includes(query) ||
    String(r.name || '').toLowerCase().includes(query) ||
    String(r.category || '').toLowerCase().startsWith(query));
}

// --limit N: cap the result set. A search UI wants a bounded list it can render
// without a scrollbar fight, and the caller can raise the cap or re-query.
const limitIdx = argv.indexOf('--limit');
const limit = limitIdx !== -1 ? Number(argv[limitIdx + 1]) : null;
if (limit && limit > 0) out = out.slice(0, limit);

if (asJson) {
  // `null, 2` pretty-printing costs 134KB for 346 tokens, which is a real
  // problem for a QML consumer: the wallet panel reads stdout through a
  // StdioCollector, and that much text did not arrive intact, so the panel
  // reported "no tokens have a live Cauldron market" while 346 tokens --
  // PUSD included -- were sitting right there. `--compact` is for machine
  // readers; the indented form stays the default because it is for humans
  // piping into jq-less eyeballs.
  const compact = argv.includes('--compact');
  console.log(JSON.stringify(out, null, compact ? 0 : 2));
  process.exit(0);
}

const SHOWN = 25;
const shown = rows.slice(0, SHOWN);
console.log(`\n  ${rows.length} tokens with a live Cauldron market, by liquidity, top ${shown.length}` +
  (rows.length > SHOWN ? ` (--json for all ${rows.length})` : '') + `\n`);
console.log(`  ${'SYMBOL'.padEnd(10)} ${'PRICE USD'.padStart(12)} ${'TVL (BCH)'.padStart(13)} ${'POOLS?'.padStart(7)}  NAME`);
console.log(`  ${'-'.repeat(10)} ${'-'.repeat(12)} ${'-'.repeat(13)} ${'-'.repeat(7)}  ${'-'.repeat(20)}`);
for (const r of shown) {
  const usd = r.price_usd == null ? '—' : (r.price_usd < 0.01 ? r.price_usd.toExponential(2) : r.price_usd.toFixed(4));
  console.log(`  ${String(r.symbol).slice(0, 10).padEnd(10)} ${usd.padStart(12)} ${(r.tvl_sats / 1e8).toFixed(4).padStart(13)} ${'yes'.padStart(7)}  ${String(r.name || '').slice(0, 28)}`);
}
console.log(`
  Every row is tradeable as:   bch-bot swap BCH <symbol> <amount>
  A token/token pair is NOT:   every pool pairs a token with BCH, so sell one
  side to BCH first, then buy the other. The CLI says so if you try.
`);
