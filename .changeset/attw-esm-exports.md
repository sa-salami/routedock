---
"@routedock/routedock": patch
"@routedock/nulth-sdk": patch
---

Point the require condition in exports at the emitted .d.cts declarations so CJS consumers on node16/nodenext get CJS types.
