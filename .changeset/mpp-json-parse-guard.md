---
"@routedock/routedock": patch
---

A 200 response with a non-JSON body now rejects with `RouteDockManifestError` on mpp-charge and `RouteDockChannelStateError` on session voucher and close, instead of a raw `SyntaxError`.
