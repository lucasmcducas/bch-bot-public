// scripts/swap-open.mjs
// Open a Cauldron swap in the user's browser, pre-filled as far as the app allows.
//
// WHY THIS EXISTS, because the honest version is not flattering.
//
// bch-bot can build a Cauldron swap correctly: it quotes, assembles, signs only
// the two inputs that are ours, and passes every check Riften's specification
// states. The transaction it produces is rejected by the network with
// "Missing inputs", because the router names a pool parent -- fd02de7d..1138 --
// whose 56 outputs are all spent, and it names it again on every quote. Measured:
// 38 of the 39 covenant locks inside that dead parent hold live positions, the
// freshest at block 971321, so the liquidity is there and the position has
// simply moved. See docs-swap-architecture.md.
//
// The router's transaction is not a template we can re-point. It is fully
// assembled, with the pool inputs chosen by the router and the constant-product
// math already worked out across every pool in the chain. Re-deriving that
// ourselves is a reimplementation of their AMM, not a one-line fix.
//
// So this does what the reference wallet does. cashonize discovers pools locally
// and then links out:
//
//   <a href="https://app.cauldron.quest/swap/${tokenData.category}">
//
// The app talks to the working router, and the browser signs. The wallet stops
// being the signer for swaps specifically. That is a real trade, not a
// workaround, and it is the only path that works today.
//
// WHAT THIS DOES NOT DO
//   - it does not sign anything, and it never touches a private key
//   - it does not move funds; the app and the user's wallet do
//   - it cannot pre-fill an amount: the app reads no query parameters, only the
//     token category in the path. The user types the amount.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveToken } from '../lib/router.mjs';

const execFileAsync = promisify(execFile);

const APP = 'https://app.cauldron.quest/swap';

/** Open a URL in the desktop's browser. Order matters: xdg-open first on Linux. */
async function openBrowser(url) {
  const attempts = [
    ['xdg-open', [url]],
    ['gio', ['open', url]],
    ['gnome-open', [url]],
    ['xdg-open', ['--', url]],
    ['sensible-browser', [url]],
  ];
  const tried = [];
  for (const [cmd, args] of attempts) {
    try {
      await execFileAsync(cmd, args, { timeout: 10000 });
      return { opened: true, via: cmd };
    } catch (e) {
      tried.push(`${cmd}: ${String(e.message).split('\n')[0].slice(0, 60)}`);
    }
  }
  return { opened: false, via: null, tried };
}

function usage() {
  console.log(`Usage: swap-open.mjs <sell> <buy>

Opens a Cauldron swap for <buy> in your browser, with <sell> preselected where the
app supports it.

Examples:
  swap-open.mjs BCH pusd
  swap-open.mjs pusd BCH

The app takes the token category in the URL path and reads no other query
parameters, so the amount is typed in the browser. Signing happens there too:
this command never touches a private key and never moves funds.

Verify the pool before trading -- the app shows TVL, 24h volume and price impact
at the top of the page.`);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  usage();
  process.exit(argv.length === 0 ? 1 : 0);
}
if (argv.length !== 2) {
  console.error('swap-open: expected exactly two arguments: <sell> <buy>');
  usage();
  process.exit(1);
}

const [sell, buy] = argv;
if (sell.toLowerCase() === buy.toLowerCase()) {
  console.error(`swap-open: sell and buy must differ (both were "${buy}")`);
  process.exit(1);
}

// The app's URL is keyed on a CashToken category, and BCH is not a CashToken --
// it has no category at all. So "buy BCH" is the one direction this launcher
// cannot open, because there is no such page to open. Say so plainly rather than
// building a URL the app will 404 on.
const NATIVE = 'bch';
if (buy.toLowerCase() === NATIVE) {
  console.error('swap-open: the Cauldron app cannot be opened for a BCH destination.');
  console.error('          Its URL is keyed on a CashToken category id, and BCH is the');
  console.error('          native asset rather than a token, so there is no page for it.');
  console.error('');
  console.error('          To sell a token for BCH, use the app directly:');
  console.error('            https://app.cauldron.quest/');
  console.error('          or pick the token there and set BCH as the receive side.');
  process.exit(1);
}

let category;
let symbol;
try {
  const token = await resolveToken(buy);
  category = token.categoryId;
  symbol = token.symbol;
} catch (e) {
  console.error(`swap-open: cannot resolve "${buy}": ${e.message}`);
  console.error('          pass a 64-character category id, e.g.');
  console.error('            swap-open.mjs BCH 2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544');
  process.exit(1);
}

if (!category || !/^[0-9a-f]{64}$/i.test(category)) {
  console.error(`swap-open: "${buy}" resolved to an unusable category: ${category}`);
  process.exit(1);
}

// A raw category id resolves to the id itself as its "symbol", which makes the
// confirmation line unreadable. Show it as what it is.
if (!symbol || symbol === category) symbol = 'that token';

const url = `${APP}/${category}`;
const result = await openBrowser(url);

if (result.opened) {
  console.log(`opened ${url}`);
  console.log(`  selling    ${sell.toUpperCase()}`);
  console.log(`  receiving  ${symbol} (${category.slice(0, 16)}..)`);
  console.log('');
  console.log('Type the amount in the browser. The quote, the pools and the price');
  console.log('impact are shown before you sign. This command signs nothing and holds');
  console.log('no keys -- the browser wallet does that part.');
  process.exit(0);
}

console.error(`swap-open: could not open a browser. Tried:`);
for (const t of result.tried) console.error(`  ${t}`);
console.error('');
console.error(`Open this manually:\n  ${url}`);
process.exit(1);
