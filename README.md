# bch-bot (public mirror)

Self-custodial Bitcoin Cash (BCH) + CashTokens wallet CLI. Node.js + libauth + public Rostrum.

This is a **public mirror** of the wallet core. The original development repo is private (contains wallet-specific configurations, secrets, and the maintainer's actual treasury setup). This mirror ships with **safe defaults** — no treasury address hardcoded, no mainnet wallet path baked in, no mainnet-specific secrets.

## What you get

- BIP39 mnemonic generation
- HD key derivation (`m/44'/145'/0'`)
- Cashaddr P2PKH address generation
- BCH send + receive (with optional `BCH_CONFIRM=yes` gate)
- CashTokens FT/NFT send + receive
- Cauldron AMM integration (swap quoting, add-liquidity)
- PUSD stake (manual signing path)
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

Or via the CLI shim:
```bash
./bin/bch-bot balance
./bin/bch-bot send bitcoincash:q... 100000
```

## Optional per-tx fee

The `lib/fee.mjs` module supports a per-tx treasury fee (default 0.5%, configurable 0-1000 bps). Set the treasury address via env var:

```bash
export BCH_TREASURY_ADDRESS="bitcoincash:your_address_here"
export BCH_TREASURY_BPS=50  # 0.5%
```

To disable fees entirely: `BCH_TREASURY_BPS=0`. The default config ships with no treasury address — fees are off until you opt in.

## Test

```bash
node scripts/test-tokens.mjs
node scripts/test-strategies.mjs
node scripts/test-pusd.mjs
node scripts/test-cauldron.mjs
node scripts/test-fee.mjs
node scripts/test-wallet-encryption.mjs
```

Total: 216 unit tests.

## Companion repos

- [lucasmcducas/bch-bot-omarchy](https://github.com/lucasmcducas/bch-bot-omarchy) — the Omarchy plugin
- [lucasmcducas/bch-wiki-public](https://github.com/lucasmcducas/bch-wiki-public) — the BCH knowledge base

## License

MIT.
