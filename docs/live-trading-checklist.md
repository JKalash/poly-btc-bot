# Live-trading checklist (BLOCKING — none of this exists yet)

This release contains **no live execution path**. Before anyone builds one, every box below must
be checked, in order. The spec's validation standards are the gate, not a formality.

## Statistical prerequisites (per strategy version)

- [ ] ≥ 1,000 out-of-sample candidate decisions recorded
- [ ] ≥ 300 realistically simulated or shadow fills
- [ ] Positive net EV after fees, spread, latency, conservative fill assumptions, adverse selection
- [ ] Positive lower confidence bound for EV
- [ ] Calibration chart without material overconfidence in the traded probability range
- [ ] No single day / minute bucket / vol regime responsible for most profits
- [ ] Walk-forward stability across multiple windows; sensitivity to 2× latency, one tick worse,
      missed cancels, reduced fill probability all reported
- [ ] Beats the no-signal book-probability baseline

## Engineering prerequisites

- [ ] CLOB V2 signing implemented against current official docs, never a fork of stale examples
- [ ] Dedicated low-balance hot wallet; allowance/balance preflight; OS-keychain or libsodium key storage
- [ ] Keys never serialized to logs, DB, browser, or error messages (verified by grep + tests)
- [ ] Live order lifecycle states reconciled against exchange + on-chain state after reconnect/restart
- [ ] Heartbeat/cancel-all protection verified against the real API
- [ ] Arming flow: re-auth, typed acknowledgement, expiring session token, automatic disarm on
      restart/deploy/credential change/integrity failure/reconciliation mismatch/kill switch
- [ ] Kill switch tested against live sandbox orders
- [ ] Fee schedule re-read live; change during armed session halts
- [ ] Geographic/legal review for the operator's jurisdiction

## Operational prerequisites

- [ ] 2 weeks of shadow mode with zero reconciliation mismatches
- [ ] Runbook rehearsal: halt, kill, restart, resolution mismatch
- [ ] Absolute cap review: the 10% per-market cap stays unless this document is amended with reasons
