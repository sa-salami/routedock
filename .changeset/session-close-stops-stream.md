---
"@routedock/routedock": minor
---

Stop `MppSessionClient.stream()` from issuing vouchers after the session closes. `close()` set an internal `closed` flag that only the `maxDurationMs` timer read, so a consumer that kept pulling the iterator ran `checkSpend()` and `mppx.fetch()` again — signing cumulative amounts above the one `close()` settles on-chain. The sequential loop and the pipelined window refill now check the flag first and end the stream with `RouteDockChannelStateError: session closed`, so a manual `close()` and the lifetime guard both halt voucher issuance immediately.
