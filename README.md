# bch-bot (public mirror)

Self-custodial Bitcoin Cash (BCH) + CashTokens wallet CLI. Node.js + libauth + public Rostrum.

This is a **public mirror** of the wallet core. The original development repo is private (contains wallet-specific configurations and the maintainer's actual wallet). This mirror ships with **safe defaults** — no third-party destinations baked in, no mainnet wallet path hardcoded, no mainnet-specific secrets.

## What you get

- BIP39 mnemonic generation
- HD key derivation (`m/44'/145'/0'`)
- Cashaddr P2PKH address generation
- BCH send + receive (with two-step `BCH_CONFIRM=yes` gate)
- CashTokens FT/NFT send + receive
- Cauldron AMM integration (swap quoting, add-liquidity operations)
- PUSD stake via a manually-built transaction path (see "PUSD stake status" below)
- Wallet encryption at rest (scrypt + aes-256-gcm)

## Install

```bash
git clone https://github.com/lucasmcducas/bch-bot-public.git
cd bch-bot-public
npm ci
```

## Use

```bash
# Create a wallet (saves to ~/.bch-wallet/wallet.json)
node scripts/create-wallet.mjs

# Encrypt it (recommended; passphrase is never stored)
BCH_WALLET_PASSPHRASE="strong-passphrase" node scripts/encrypt-wallet.mjs

# Show your receiving address
node scripts/address.mjs

# Check balance
node scripts/balance.mjs

# Send (BCH_CONFIRM=yes required to broadcast)
node scripts/send.mjs bitcoincash:qrecipient_address_here 100000
```

## Test

Run the full suite from a clean clone:

```bash
git clone https://github.com/lucasmcducas/bch-bot-public.git
cd bch-bot-public
npm ci
for f in scripts/test-*.mjs; do echo "=== $f ==="; node "$f" 2>&1 | tail -1; done
```

Expected output (verified 2026-10-01 against the public mirror):

```
$ npm test
lint-unused: clean (40 files checked, 0 unused imports)
RESULT: 40 passed, 0 failed (40 total)     test-tokens.mjs
RESULT: 33 passed, 0 failed (33 total)     test-pusd.mjs
RESULT: 38 passed, 0 failed (38 total)     test-cauldron.mjs
PASSED 31, FAILED 0                        test-wallet-encryption.mjs
RESULT: 18 passed, 0 failed (18 total)     test-router.mjs
RESULT: 12 passed, 0 failed (12 total)     test-external-signing.mjs
RESULT: 20 passed, 0 failed (20 total)     test-send-amount.mjs
RESULT: 12 passed, 0 failed (12 total)     test-swap-outputs.mjs
RESULT: 38 passed, 0 failed (38 total)     test-wallet.mjs
RESULT: 36 passed, 0 failed (36 total)     test-pusd-fingerprints.mjs
RESULT: 27 passed, 0 failed (27 total)     test-sweep-selection.mjs
RESULT:  7 passed, 0 failed ( 7 total)     test-signer-binding.mjs
RESULT: 47 passed, 0 failed (47 total)     test-network.mjs
RESULT: 29 passed, 0 failed (29 total)     test-kdf-params.mjs
```

Total: **388 assertions across 14 files**, plus the unused-import lint. Run `npm run lint`
on its own for just that check.

Note on counting: `test-wallet-encryption.mjs` uses a different runner that prints
`PASSED n, FAILED n` rather than a `RESULT:` line, so grepping only for `RESULT:`
under-reports the total. A test that passes is not automatically a test that can
fail — see the note below.

### What was removed, and why

`scripts/test-strategies.mjs` (43 assertions) was deleted. It contained **zero
imports**: every assertion checked values constructed as literals a few lines
above it, and one block defined `sighashFor` inside the test and then asserted on
the test's own function. It could not fail under any defect in `lib/`.

What it claimed to cover is covered for real elsewhere: sighash flag selection
(`0x41`/`0x61`) by `test-external-signing.mjs` and `test-pusd.mjs`; the PUSD
receipt commitment by `test-pusd.mjs`; token output shape by `test-tokens.mjs`.
A test that cannot fail is not coverage — it is the largest block of false
confidence a suite can contain, and it makes the count look healthier than the
suite is.

## Network configuration (Rostrum)

This wallet talks to a public Rostrum/Electrum server to discover UTXOs and broadcast transactions. **The default server (`cashnode.bch.ninja:50004`) is a single point of trust.** A malicious server could lie about your balance or censor your transactions.

The wallet includes a failover list (`lib/network.mjs`) that tries multiple servers on connect failure, but it cannot detect a server that lies correctly. **For production use, run your own BCHN + Fulcrum stack and point the wallet at it.**

Configuration:

```bash
# Use your own Rostrum server
export BCH_ROSTRUM="my-rostrum.example.com:50004"

# Or in config/default.json
{ "rostrum": { "mainnet": "my-rostrum.example.com:50004" } }
```

There is no warning when using the default server. This is a known limitation — see the wiki's security KB (`security/utxo-and-mempool.md` and `security/wallet-threat-model.md`) for the threat model.

## PUSD stake status

PUSD stake is **partially implemented**. The transaction builder in `lib/pusd.mjs` constructs the stake output structure, and `scripts/test-pusd.mjs` exercises the design contracts. However, **end-to-end signing is not yet wired**: input 2 (the covenant input to the PUSD stake contract) requires manual signing because libauth v3.0.0 has a known bug in the 0x61 sighash path that the wallet works around. Until either libauth ships a fix or the wallet ships its own signing-serialization implementation, the `stake.mjs` script will build and sign 3 of 4 inputs but leave input 2 unsigned.

For practical use today: stake PUSD via a UI wallet (Electron Cash, Cashtab) instead.

## Repository scope

This public mirror is **the source of truth for everything except the maintainer's actual wallet configuration**. If you fork this repo and add a feature, your fork IS the implementation. The private `lucasmcducas/bch-bot` repo contains the maintainer's wallet.json and mainnet test results; it does not contain divergent code. Specifically:

- All `lib/*.mjs` files in the public mirror are byte-identical to the private repo's `lib/` (modulo default values which are empty in public).
- All `scripts/*.mjs` files in the public mirror are byte-identical.
- The private repo additionally holds the maintainer's own wallet configuration and
  a separately kept mainnet wallet directory, neither of which belongs in a public tree.

If you find divergence, please open an issue.

## Companion repos

- [lucasmcducas/bch-bot-omarchy](https://github.com/lucasmcducas/bch-bot-omarchy) — the Omarchy plugin
- [lucasmcducas/bch-wiki-public](https://github.com/lucasmcducas/bch-wiki-public) — the BCH knowledge base

## License

MIT.
