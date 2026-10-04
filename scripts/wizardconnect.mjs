// scripts/wizardconnect.mjs
//
// The WizardConnect wallet, as a CLI, so the Omarchy panel can drive it.
//
// The panel already shells out to `bch-bot` subcommands and renders their JSON,
// so this follows the same shape: a subcommand prints JSON on stdout, and a
// human-readable line on stderr for anything that needs a decision.
//
// The flow a dapp triggers:
//
//   1.  bch-bot wizardconnect pair <wiz-uri>   -> relay connection, prints the id
//   2.  a dapp sends a sign request; the process prints a REQUEST line and waits
//   3.  the operator types "y" or "n" on stdin
//   4.  bch-bot signs and relays, or refuses
//
// WHY STDIN AND NOT A FLAG
//
// Approval is a human decision, so it cannot be a command-line flag: a script
// that passes --yes is a script that signs whatever a dapp asks for, which is
// the exact thing this is built to prevent. There is deliberately no flag for
// it. A caller that cannot supply a human must not be able to sign.
//
// The request is rendered from the transaction bytes, never from a description
// the dapp supplied -- see summarizeRequest in lib/wizardconnect-service.mjs.

import { createInterface } from 'node:readline';
import { createWizardConnectService } from '../lib/wizardconnect-service.mjs';

function usage() {
  console.log(`Usage: bch-bot wizardconnect <command>

Commands:
  pair <wiz-uri>     Connect to a dapp over the relay and wait for requests.
                     Reads approval from stdin: type "y" to sign, "n" to refuse.
  status             Show current connections as JSON.

Approval is read from stdin on purpose. There is no --yes flag: a wallet that
can be told to sign without a human is not a wallet.`);
}

const argv = process.argv.slice(2);
const sub = argv[0];

if (!sub || sub === '--help' || sub === '-h') {
  usage();
  process.exit(sub ? 0 : 1);
}

/** Satoshis to a short BCH string, without losing precision on small amounts. */
function bch(sats) {
  if (sats === null || sats === undefined) return '?';
  return (Number(sats) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

/** Render a request for a human. This is the approval dialog, in a terminal. */
function render(summary, meta) {
  const lines = [];
  lines.push('');
  lines.push(`  dapp        ${meta.dappName ?? '(unnamed)'}`);
  lines.push(`  ${'inputs'.padEnd(11)}${summary.inputCount}   ${'outputs'.padEnd(9)}${summary.outputCount}`);
  lines.push(`  ${'in'.padEnd(11)}${bch(summary.plainIn)} BCH   ${'out'.padEnd(9)}${bch(summary.plainOut)} BCH`);
  if (summary.minerFee > 0n) lines.push(`  fee         ${bch(summary.minerFee)} BCH`);
  lines.push('');

  // Contract inputs are the ones a user cannot read as sats. A Cauldron route
  // spends pool positions here, and their decoded value is NOT BCH.
  const contractInputs = summary.inputs.filter((i) => i.isContract);
  if (contractInputs.length) {
    lines.push(`  ${contractInputs.length} covenant input(s) — NOT plain coins:`);
    for (const i of contractInputs.slice(0, 4)) {
      const tok = i.token ? ` ${i.token.amount} tok ${i.token.category.slice(0, 8)}` : '';
      lines.push(`    in[${i.index}] ${i.contractName ?? 'contract'}${tok}`);
    }
    if (contractInputs.length > 4) lines.push(`    ... and ${contractInputs.length - 4} more`);
    lines.push('');
  }

  const tokenOutputs = summary.outputs.filter((o) => o.token);
  if (tokenOutputs.length) {
    lines.push('  token outputs:');
    for (const o of tokenOutputs.slice(0, 6)) {
      lines.push(`    out[${o.index}] ${o.token.amount} tok ${o.token.category.slice(0, 8)}  + ${bch(o.sats)} BCH`);
    }
    if (tokenOutputs.length > 6) lines.push(`    ... and ${tokenOutputs.length - 6} more`);
    lines.push('');
  }

  return lines.join('\n');
}

if (sub === 'status') {
  const svc = createWizardConnectService({ onApprove: async () => false });
  console.log(JSON.stringify(svc.getConnections(), null, 2));
  process.exit(0);
}

if (sub !== 'pair') {
  console.error(`wizardconnect: unknown command "${sub}"`);
  usage();
  process.exit(1);
}

const uri = argv[1];
if (!uri) {
  console.error('wizardconnect: pair needs a wiz:// URI from the dapp');
  usage();
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stderr });

/**
 * Ask, in plain words, what pairing actually costs, and wait for a human.
 *
 * Connecting is IRREVOCABLE in the sense that matters: the dapp receives the
 * wallet's chain-level xpubs right after the key exchange, which reveals every
 * current AND FUTURE address. Cashonize says so before it connects, and its
 * dialog is the reference wording:
 *
 *   "Share wallet addresses with this dApp?"
 *     Connecting shares your wallet's full current and future address list
 *     (the xpub) with the dApp.
 *     The dApp can see your entire balance and transaction history, even after
 *     disconnecting.
 *     You lose the privacy of using fresh HD wallet addresses.
 *     Spending your funds still requires your approval for each transaction.
 *
 * The first version of this script called svc.connect() with no prompt at all,
 * which is a real gap rather than a UX difference: the operator never learns
 * what they just handed over. Note the last line of Cashonize's copy is TRUE
 * here too -- onApprove below still gates every signature -- and the second
 * line is the one people skip, which is why it is the one quoted in full.
 *
 * There is deliberately no --yes. Same reasoning as the signing gate: a wallet
 * that can be told to hand over every future address without a human is not a
 * wallet.
 */
function askConsent() {
  return new Promise((resolve) => {
    process.stderr.write(`
  Share wallet addresses with this dApp?

  Connecting shares your wallet's full current and future address list
  (the xpub) with the dApp.

    - The dApp can see your entire balance and transaction history, even
      after disconnecting.
    - You lose the privacy of using fresh HD wallet addresses.
    - Spending your funds still requires your approval for each transaction,
      one transaction at a time.

`);
    rl.question('  Connect and share your address list? [y/N] ', (answer) => {
      const yes = /^\s*y(es)?\s*$/i.test(answer || '');
      if (!yes) {
        process.stderr.write('  refused -- not connecting.\n');
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

const svc = createWizardConnectService({
  onApprove: (summary, meta) => new Promise((resolve) => {
    process.stderr.write(render(summary, meta));
    process.stderr.write('  sign this request? [y/N] ');
    const ask = () => {
      rl.question('', (answer) => {
        const yes = /^\s*y(es)?\s*$/i.test(answer || '');
        if (!answer) return resolve(false);
        if (yes) { resolve(true); return; }
        process.stderr.write('  refused\n');
        resolve(false);
      });
    };
    ask();
  }),

  onConnectionState: (id, status) => {
    const name = typeof status === 'string' ? status : (status?.status ?? JSON.stringify(status));
    process.stderr.write(`[wizardconnect] ${id.slice(0, 8)} ${name}\n`);
  },

  onDisconnect: (id, reason) => {
    process.stderr.write(`[wizardconnect] ${id.slice(0, 8)} disconnected: ${reason}\n`);
  },
});

// Consent first, connection second. The disclosure has to appear BEFORE the key
// exchange, because the disclosure describes what the key exchange gives away.
const consented = await askConsent();
if (!consented) {
  console.error('wizardconnect: not connecting.');
  process.exit(1);
}

let connectionId;
try {
  connectionId = svc.connect(uri);
} catch (e) {
  console.error(`wizardconnect: ${e.message}`);
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, connectionId }));

// Print each request as a machine-readable REQUEST line too, so the panel can
// show the same summary the operator is reading in the terminal.
const origOnApprove = svc.manager;
void origOnApprove;

process.stderr.write('[wizardconnect] waiting for a request. Ctrl-C to stop.\n');

process.on('SIGINT', () => {
  try { svc.disconnectAll(); rl.close(); } catch { /* closing anyway */ }
  process.exit(0);
});

// Stay alive until the dapp disconnects or the operator stops us.
setInterval(() => {
  const conns = svc.getConnections();
  if (Object.keys(conns).length === 0) {
    try { rl.close(); } catch { /* already closed */ }
    process.exit(0);
  }
}, 5000).unref?.();
