---
'@routedock/routedock': patch
---

Abandoned MPP session recovery now selects only the rows it can actually settle. The reconciler filters on the configured `network` and on the payee public key, requires a non-null `last_signature` (an unsigned row cannot be closed and no longer consumes a slot in the batch), and orders by `updated_at` ascending before `limit(100)`. Previously a mixed-network or mixed-payee backlog could fill the whole batch with rows this provider would skip, so older recoverable sessions were starved and never settled.
