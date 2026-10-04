// scripts/test-swap-receive-value.mjs — proves the gate catches a short payment.
//
// THE BUG (2026-10-02, real, found by the security audit): the old
// verifyTransactionOutputs byte-compared every output against our addresses,
// which correctly catches REDIRECTION, but never compared the VALUE of an output
// already proven ours. A router that quoted 36,141 and built an output paying
// our own address 1 base unit passed every gate: the destination is genuinely
// ours, the pool count matches, no token category is wrong. The user signs it and
// receives nothing.
//
// Ownership answers "is this my money going somewhere I did not agree to?"
// It cannot answer "is my money arriving short?" Those are different questions
// and only the second one needs the amount.
//
// THAT BUG IS GONE WITH THE ROUTER, BUT THE QUESTION IS NOT. ExchangeLab quotes
// and builds from the same local pool state, so it cannot produce a short
// payment by divergence. The class of defect moved rather than vanished, and the
// cheap way for it to come back is for someone to let a caller pass buildSwap a
// pool list the user never approved a quote for.
//
// So the test survives, retargeted: verifyAgainstQuote must refuse a built
// transaction whose payout is below the quote it claims to satisfy, and must
// refuse a quote carrying no expected amount at all. Those two refusals are the
// guard. A guard nobody exercises is a guard that has already decayed.
//
// Run: node scripts/test-swap-receive-value.mjs

import { verifyAgainstQuote } from '../lib/exlab-swap.mjs';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const CATEGORY = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
const QUOTED = 36141n;   // what the quote promised
const PAID = 1n;         // what a short-paying build produces

/** A minimal TradeResult shaped exactly as the SDK returns it. */
function fakeTrade(demand) {
  return {
    entries: [{
      supply_token_id: 'BCH',
      demand_token_id: CATEGORY,
      supply: 97036n,
      demand,
      trade_fee: 290n,
      pool: { outpoint: { index: 41, txhash: new Uint8Array(32) } },
    }],
    summary: { supply: 97036n, demand, trade_fee: 290n },
  };
}

/** payouts_info shaped exactly as createTradeTx returns it, buying a token. */
function fakeBuilt(paid) {
  return {
    payoutsInfo: [
      { index: 2, output: { amount: 0n, token: { amount: paid, token_id: CATEGORY } } },
      { index: 3, output: { amount: 900000n, token: null } },
    ],
  };
}

/**
 * The BUY-FOR-BCH shape, which is not a variation but a different shape.
 *
 * A token sell that pays out BCH has demand_token_id 'BCH' and the payout's
 * token is NULL, with the amount in satoshis. This case is here because the
 * guard shipped without it and then refused a real, correct swap with "built
 * transaction has no BCH payout to compare against the quote" -- a guard that is
 * right for the wrong reason and blocks the trade it exists to protect.
 */
function fakeBchTrade(demand) {
  return {
    entries: [{
      supply_token_id: CATEGORY,
      demand_token_id: 'BCH',
      supply: 31n,
      demand,
      trade_fee: 293n,
      pool: { outpoint: { index: 41, txhash: new Uint8Array(32) } },
    }],
    summary: { supply: 31n, demand, trade_fee: 293n },
  };
}

function fakeBchBuilt(sats) {
  return {
    payoutsInfo: [
      { index: 2, output: { amount: BigInt(sats), token: null } },
      { index: 3, output: { amount: 0n, token: null } },
    ],
  };
}

await test('a build paying exactly the quote passes', async () => {
  const r = verifyAgainstQuote({ trade: fakeTrade(QUOTED), built: fakeBuilt(QUOTED) });
  assert(r.ok, `expected pass, got: ${r.problems.join('; ')}`);
  assert(r.paidOut === QUOTED, 'paidOut should equal the quote');
});

await test('a build paying SHORT of the quote is refused', async () => {
  const r = verifyAgainstQuote({ trade: fakeTrade(QUOTED), built: fakeBuilt(PAID) });
  assert(!r.ok, 'a short payment must be refused');
  assert(
    r.problems.some((p) => p.includes(String(PAID)) && p.includes(String(QUOTED))),
    `the refusal must name both amounts, got: ${r.problems.join('; ')}`,
  );
});

await test('a quote with no demand amount is refused, not trusted', async () => {
  // The original bug in its purest form: nothing to compare against, so a
  // verifier that only checks ownership would wave it through.
  const trade = fakeTrade(QUOTED);
  trade.summary.demand = undefined;
  const r = verifyAgainstQuote({ trade, built: fakeBuilt(QUOTED) });
  assert(!r.ok, 'a quote with no expected output must be refused');
  assert(
    r.problems.some((p) => /no expected output/i.test(p)),
    `expected a "no expected output" problem, got: ${r.problems.join('; ')}`,
  );
});

await test('a build with no payout for the quoted token is refused', async () => {
  const built = { payoutsInfo: [{ index: 3, output: { amount: 900000n, token: null } }] };
  const r = verifyAgainstQuote({ trade: fakeTrade(QUOTED), built });
  assert(!r.ok, 'a missing payout must be refused');
  assert(
    r.problems.some((p) => /no .* payout/i.test(p)),
    `expected a "no payout" problem, got: ${r.problems.join('; ')}`,
  );
});

await test('a user-set minimum above the built amount is refused', async () => {
  const r = verifyAgainstQuote({ trade: fakeTrade(QUOTED), built: fakeBuilt(QUOTED), minOutputBaseUnits: 999999n });
  assert(!r.ok, 'below the user minimum must be refused');
  assert(
    r.problems.some((p) => /minimum/i.test(p)),
    `expected a minimum problem, got: ${r.problems.join('; ')}`,
  );
});

await test('a user-set minimum the build meets passes', async () => {
  const r = verifyAgainstQuote({ trade: fakeTrade(QUOTED), built: fakeBuilt(QUOTED), minOutputBaseUnits: QUOTED });
  assert(r.ok, `expected pass, got: ${r.problems.join('; ')}`);
});

await test('a buy-for-BCH build paying the quoted sats passes', async () => {
  const r = verifyAgainstQuote({ trade: fakeBchTrade(97844n), built: fakeBchBuilt(97928n) });
  assert(r.ok, `expected pass, got: ${r.problems.join('; ')}`);
  assert(r.paidOut === 97928n, `paidOut should be the sat amount, got ${r.paidOut}`);
});

await test('a buy-for-BCH build paying SHORT is refused', async () => {
  const r = verifyAgainstQuote({ trade: fakeBchTrade(97844n), built: fakeBchBuilt(1n) });
  assert(!r.ok, 'a short BCH payment must be refused');
  assert(
    r.problems.some((p) => p.includes('97844')),
    `the refusal must name the quoted amount, got: ${r.problems.join('; ')}`,
  );
});

await test('a buy-for-BCH build with no payout at all is refused', async () => {
  const built = { payoutsInfo: [{ index: 3, output: { amount: 0n, token: null } }] };
  const r = verifyAgainstQuote({ trade: fakeBchTrade(97844n), built });
  assert(!r.ok, 'a missing BCH payout must be refused');
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
