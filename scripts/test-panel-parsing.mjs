// scripts/test-panel-parsing.mjs
//
// The Omarchy panel turns `bch-bot balance` JSON into what it renders. That
// translation lives in QML, so it cannot be unit-tested from here -- but the
// part that decides what a user SEES is the shape of the JSON, and that is
// testable.
//
// This mirrors the panel's applyResult() balance branch exactly. If the CLI's
// balance shape changes and this file is not updated in step, the panel either
// renders an empty token list or a raw base-unit figure, and neither failure is
// visible from the CLI side.

let passed = 0;
let failed = 0;
function eq(actual, expected, label) {
  if (actual === expected) { passed++; return; }
  failed++;
  console.error(`  ✗ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function ok(v, label) { if (v) { passed++; return; } failed++; console.error(`  ✗ ${label}`); }

// The panel's own conversion, copied from BchWalletPanel.qml applyResult().
function applyBalance(parsed) {
  const balanceBch = String(parsed.bch_confirmed || '0.00000000');
  const balanceUnconfirmed = String(parsed.bch_unconfirmed || '0.00000000');
  const utxoCount = Number(parsed.utxo_count || 0);
  const list = [];
  const byCategory = parsed.tokens || {};
  for (const key in byCategory) {
    if (!Object.prototype.hasOwnProperty.call(byCategory, key)) continue;
    const t = byCategory[key];
    list.push({
      category: key,
      symbol: t.symbol || t.short_id || 'token',
      display: t.display || t.amount || '0',
      amount: String(t.amount || '0'),
      decimals: Number(t.decimals || 0),
      known: t.known === true,
    });
  }
  return { balanceBch, balanceUnconfirmed, utxoCount, tokens: list };
}

console.log('--- the real mainnet balance, as the device produced it ---');
{
  // Verbatim from `bch-bot balance` against the funded wallet.
  const raw = {
    network: 'mainnet',
    satoshis_confirmed: '1658855',
    satoshis_unconfirmed: '0',
    bch_confirmed: '0.01658855',
    bch_unconfirmed: '0.00000000',
    utxo_count: 4,
    token_categories_ft: 1,
    tokens: {
      '892cef80a326f92583766abb85562f550fe6a6ff9a7d458067680c720135ff53': {
        category: '892cef80a326f92583766abb85562f550fe6a6ff9a7d458067680c720135ff53',
        symbol: 'ROACH', name: 'Roach', decimals: 2, known: true,
        amount: '100', display: '1',
        short_id: '892cef80a326f925…',
      },
    },
  };
  const v = applyBalance(raw);
  eq(v.balanceBch, '0.01658855', 'balance: ');
  eq(v.utxoCount, 4, 'utxo count: ');
  eq(v.tokens.length, 1, 'token count: ');
  // The whole point of the change: a symbol and a real amount, not "100".
  eq(v.tokens[0].symbol, 'ROACH', 'symbol: ');
  eq(v.tokens[0].display, '1', 'display: ');
  eq(v.tokens[0].amount, '100', 'exact base units are kept alongside: ');
  ok(v.tokens[0].known, 'a registry-known token is flagged known');
}

console.log('--- an unknown token renders without inventing a symbol ---');
{
  const v = applyBalance({
    bch_confirmed: '0.5',
    tokens: {
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': {
        amount: '10000', decimals: 2, known: false, short_id: 'aaaaaaaaaaaaaa…',
      },
    },
  });
  eq(v.tokens[0].symbol, 'aaaaaaaaaaaaaa…', 'falls back to the short id: ');
  eq(v.tokens[0].display, '10000', 'display falls back to the raw amount: ');
  ok(!v.tokens[0].known, 'flagged unknown, so the UI can show the base units');
  // 64 hex characters is not a label and would blow out the layout.
  ok(v.tokens[0].symbol.length < 20, 'the fallback label stays short');
}

console.log('--- a wallet with no tokens is not a wallet with an error ---');
{
  const v = applyBalance({ bch_confirmed: '0.00000000', utxo_count: 0, tokens: {} });
  eq(v.tokens.length, 0, 'no tokens: ');
  eq(v.balanceBch, '0.00000000', 'zero balance: ');
  eq(v.utxoCount, 0, 'zero utxos: ');
  // The panel hides the Tokens section on an empty list; if this were ever
  // non-empty the user would see a heading with nothing under it.
  eq(v.tokens.length > 0, false, 'the token section is hidden');
}

console.log('--- an unconfirmed deposit is surfaced, not folded away ---');
{
  // A mempool deposit is real money that is not yet spendable. Folding it into
  // the confirmed figure would overstate what can be spent; dropping it would
  // look like the balance fell.
  const v = applyBalance({ bch_confirmed: '0.00200000', bch_unconfirmed: '0.00800000', utxo_count: 3 });
  eq(v.balanceUnconfirmed, '0.00800000', 'unconfirmed is carried separately: ');
  ok(Number(v.balanceUnconfirmed) > 0, 'so the UI can show a "confirming" line');
  eq(v.balanceBch, '0.00200000', 'confirmed is untouched: ');
}

console.log('--- malformed input degrades instead of throwing ---');
{
  const v = applyBalance({});
  eq(v.balanceBch, '0.00000000', 'missing balance defaults: ');
  eq(v.utxoCount, 0, 'missing utxos default: ');
  eq(v.tokens.length, 0, 'missing tokens default: ');
  // A null token map must not become a crash inside a QML for-in loop.
  const w = applyBalance({ bch_confirmed: '1', tokens: null });
  eq(w.tokens.length, 0, 'null tokens map is handled: ');
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
