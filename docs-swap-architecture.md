# How a working BCH wallet actually does swaps

Luke: "dont forget to check cashonize code/docs if you have questions."
I had read Cashonize for pool discovery and stopped there. Reading it for the swap
path proper changes the plan, so it is written down before anything is built.

## Cashonize does not swap. It links out.

    src/components/tokenItems/tokenItemFT.vue:270

      <a :href="`https://app.cauldron.quest/swap/${tokenData.category}`"
         target="_blank">

The wallet discovers pools locally, displays them, and hands the user to the web
app in a browser. There is no in-wallet swap execution path in Cashonize to copy.

Its own files are all discovery or display:

| File | What it actually does |
|---|---|
| `defi/cauldronPools.ts` | derive a pool owner contract address, list its UTXOs |
| `defi/cauldronApi.ts` | prices from the indexer, 5 min cache, nothing else |
| `defi/tapswapListings.ts` | list TapSwap listings |
| `defi/hodlContracts.ts` | time-locked BCH, not trading |

So there is no second router to switch to. Riften runs the router, the pools and
the front end.

## The front end is alive, and it is the ground truth

    https://app.cauldron.quest/swap/2469acc5...   (PUSD category)

```
PUSD   $1.002846
TVL          $244,664.28    390.3 BCH / 121.9K PUSD
Volume 24h     $8,843.39     28.2 BCH / 8.6K PUSD
Volume 30d       $1.02M
```

Live swap form, quote renders, price impact shown. $8.8k traded in the last day
and $244k sitting in the pools.

Luke said swaps are happening on Cauldron. Here is the number.

## Hosts the app uses, from its own bundle

| Host | Role |
|---|---|
| `app.cauldron.quest` | the app; also `/thorchain/quote/swap`, `/trades/recent` |
| `signer.riften.net` | transaction signing |
| `indexer.riften.net` | token and pool metadata |
| `meta.riften.net` | token metadata |
| `thornode.riften.net` | returns Stratum error code 12 — a mining node, not for us |
| `sock.cauldron.quest` | websocket |

No public router host. `/dswap` in the bundle is a client-side SPA route, not an
API — `GET /dswap` returns the app shell.

## What this changes about the plan

The mechanism I had is still right: a pool position is derivable from public data,
and 38 of the 39 covenants in the drained parent hold live positions. But the plan
I was about to build assumed the router's transaction is a template we can
re-point at a different outpoint.

**It is not.** It is a fully assembled transaction whose pool inputs are chosen by
the router, with the constant-product math already worked out across every pool in
the chain. Re-pointing those inputs means re-deriving that math ourselves — which
is not "swap one field", it is reimplementing their AMM.

So the options are:

| | Effort | Works today |
|---|---|---|
| (a) Re-derive the route ourselves, including CPMM math | weeks, duplicates the AMM | no |
| (b) Swap through the web app, the way Cashonize does | small | **yes** |
| (c) Report the drained parent to Riften and wait | one message | no |

Nothing is built. This is the decision, not the implementation.

## What actually happened here

I had the mechanism right and the plan wrong. Reading one reference
implementation for the thing it does *not* do would have saved that — and I only
read it because Luke said to, after I had already started building the wrong
thing.
