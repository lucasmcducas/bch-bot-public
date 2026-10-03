// RETIRED. The code it tested is gone.
//
// scripts/test-swap-outputs.mjs asserted that verifyTransactionOutputs --
// verifyBuildAgainstQuote -- refused router builds that paid the swap output to
// the wrong address, committed to more pools than quoted, or carried the wrong
// token category. Every one of those guards was a check on a SERVER-ASSEMBLED
// transaction, and the server is gone.
//
// The reasoning is not lost and the coverage is not lost:
//   - redirection / wrong-destination  -> gone with the router; a local build
//     cannot pay anyone but the change address the caller supplies
//   - wrong amount                     -> lib/exlab-swap.mjs verifyAgainstQuote,
//     covered by scripts/test-swap-receive-value.mjs
//   - pool count and category mismatch -> were router-specific; ExchangeLab
//     derives both from the quote it was handed
//
// Do not restore this file. If a guard against a mis-paid swap is wanted again,
// it belongs in test-swap-receive-value.mjs, which is where the short-payment
// case now lives.

process.exit(0);
