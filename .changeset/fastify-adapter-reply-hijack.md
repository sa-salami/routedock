---
"@routedock/routedock": patch
---

Fix Fastify provider adapter reply hijacking before payment handler execution so paid requests do not hang after settlement.
