# Pair research report: synthetic-zero-opportunity-v1

## 1. Executive conclusion

**REMAIN_OBSERVER_ONLY** — One or more research gates failed; remain observer-only.

Live capability: **DOES NOT EXIST**.

## 2. Dataset and provenance

- Dataset ID: `synthetic-zero-opportunity-validation-v1`
- Dataset hash: `cc3b57ec2f3ab5238e0ebce6871329eb23e5f5c7344d74bec0b85c13d7291644`
- Replay output hash: `b10970826477b8a6f1721625093cbfc398ab4d171a82cdb92fa276fcc33ddc18`
- Clock/tie versions: `pair_replay_clock_v1` / `pair_replay_tie_v1`
- Code commit: `0000000`
- Strategy / paper venue: `synthetic_validation_only_v1` / `synthetic_no_venue_v1`

## 3. Fee and constraint regime

- Fee snapshot hashes: MISSING
- Constraint snapshot hashes: MISSING
- Resolution hashes: none

## 4. Funnel

| Metric | Count | Denominator | Rate |
|---|---:|---:|---:|
| MARKETS_OBSERVED | 0 | 0 | N/A |
| COMPLETE_ENVELOPES_CAPTURED | 0 | 0 | N/A |
| VALID_SYNCHRONIZED_CAPTURES | 0 | 0 | N/A |
| PREFILTER_BAND_CAPTURES | 0 | 0 | N/A |
| GROSS_ASK_SUM_DISLOCATIONS | 0 | 0 | N/A |
| FULL_DEPTH_EXECUTABLE_DISLOCATIONS | 0 | 0 | N/A |
| FEE_POSITIVE_OBSERVATIONS | 0 | 0 | N/A |
| MINIMUM_PNL_SURVIVORS | 0 | 0 | N/A |
| MINIMUM_RETURN_SURVIVORS | 0 | 0 | N/A |
| ONE_TICK_STRESS_SURVIVORS | 0 | 0 | N/A |
| TWO_TICK_STRESS_SURVIVORS | 0 | 0 | N/A |
| UNIQUE_OPPORTUNITY_EPISODES | 0 | 0 | N/A |
| SCHEDULED_ACTIVATION_CANDIDATES | 0 | 0 | N/A |
| ACTIVATION_DATA_AVAILABLE | 0 | 0 | N/A |
| ACTIVATION_ECONOMICS_SURVIVED | 0 | 0 | N/A |
| BOTH_INITIAL_LEGS_FILLED | 0 | 0 | N/A |
| BOTH_INITIAL_LEGS_ZERO_FILLED | 0 | 0 | N/A |
| ONE_LEG_RESIDUALS | 0 | 0 | N/A |
| UNKNOWN_OUTCOMES | 0 | 0 | N/A |
| RECOVERY_ATTEMPTS | 0 | 0 | N/A |
| RECOVERY_DISPOSITIONS | 0 | 0 | N/A |
| PAIRED_SETTLEMENTS | 0 | 0 | N/A |
| REALIZED_WINS | 0 | 0 | N/A |
| REALIZED_LOSSES | 0 | 0 | N/A |
| RECONCILIATION_MISMATCHES | 0 | 0 | N/A |

## 5. Episode distributions

| Metric | N | Median | P75 | P90 | P95 | P99 | Max |
|---|---:|---:|---:|---:|---:|---:|---:|
| activationDelayMs | 0 | N/A | N/A | N/A | N/A | N/A | N/A |
| activationNetPnl6 | 0 | N/A | N/A | N/A | N/A | N/A | N/A |
| crossLegSkewMs | 0 | N/A | N/A | N/A | N/A | N/A | N/A |
| durationMs | 0 | N/A | N/A | N/A | N/A | N/A | N/A |
| executableNotional6 | 0 | N/A | N/A | N/A | N/A | N/A | N/A |
| interLegDelayMs | 0 | N/A | N/A | N/A | N/A | N/A | N/A |
| pnlContribution6 | 0 | N/A | N/A | N/A | N/A | N/A | N/A |
| receiveBookAgeMs | 0 | N/A | N/A | N/A | N/A | N/A | N/A |
| signalNetPnl6 | 0 | N/A | N/A | N/A | N/A | N/A | N/A |
| sourceBookAgeMs | 0 | N/A | N/A | N/A | N/A | N/A | N/A |
| worstCaseLoss6 | 0 | N/A | N/A | N/A | N/A | N/A | N/A |

## 6. Latency and dispatch matrix

| Cell | Dispatch | Latency ms | Inter-leg ms | Depth bps | Stress ticks | PnL6 | Lower 95% |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | PARALLEL | 350 | 0 | 10000 | 0 | 0 | INSUFFICIENT_SAMPLE |
| latency_0ms | PARALLEL | 0 | 0 | 10000 | 0 | 0 | INSUFFICIENT_SAMPLE |
| latency_100ms | PARALLEL | 100 | 0 | 10000 | 0 | 0 | INSUFFICIENT_SAMPLE |
| latency_250ms | PARALLEL | 250 | 0 | 10000 | 0 | 0 | INSUFFICIENT_SAMPLE |
| latency_500ms | PARALLEL | 500 | 0 | 10000 | 0 | 0 | INSUFFICIENT_SAMPLE |
| latency_1000ms | PARALLEL | 1000 | 0 | 10000 | 0 | 0 | INSUFFICIENT_SAMPLE |
| latency_2x_p95 | PARALLEL | 600 | 0 | 10000 | 0 | 0 | INSUFFICIENT_SAMPLE |
| dispatch_up_then_down_25ms | UP_THEN_DOWN | 350 | 25 | 10000 | 0 | 0 | INSUFFICIENT_SAMPLE |
| dispatch_up_then_down_50ms | UP_THEN_DOWN | 350 | 50 | 10000 | 0 | 0 | INSUFFICIENT_SAMPLE |
| dispatch_up_then_down_100ms | UP_THEN_DOWN | 350 | 100 | 10000 | 0 | 0 | INSUFFICIENT_SAMPLE |
| dispatch_up_then_down_250ms | UP_THEN_DOWN | 350 | 250 | 10000 | 0 | 0 | INSUFFICIENT_SAMPLE |
| dispatch_down_then_up_25ms | DOWN_THEN_UP | 350 | 25 | 10000 | 0 | 0 | INSUFFICIENT_SAMPLE |
| dispatch_down_then_up_50ms | DOWN_THEN_UP | 350 | 50 | 10000 | 0 | 0 | INSUFFICIENT_SAMPLE |
| dispatch_down_then_up_100ms | DOWN_THEN_UP | 350 | 100 | 10000 | 0 | 0 | INSUFFICIENT_SAMPLE |
| dispatch_down_then_up_250ms | DOWN_THEN_UP | 350 | 250 | 10000 | 0 | 0 | INSUFFICIENT_SAMPLE |

## 7. Depth and tick stress

| Cell | Dispatch | Latency ms | Inter-leg ms | Depth bps | Stress ticks | PnL6 | Lower 95% |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | PARALLEL | 350 | 0 | 10000 | 0 | 0 | INSUFFICIENT_SAMPLE |
| depth_7500bps | PARALLEL | 350 | 0 | 7500 | 0 | 0 | INSUFFICIENT_SAMPLE |
| depth_5000bps | PARALLEL | 350 | 0 | 5000 | 0 | 0 | INSUFFICIENT_SAMPLE |
| depth_2500bps | PARALLEL | 350 | 0 | 2500 | 0 | 0 | INSUFFICIENT_SAMPLE |
| stress_1tick | PARALLEL | 350 | 0 | 10000 | 1 | 0 | INSUFFICIENT_SAMPLE |
| stress_2tick | PARALLEL | 350 | 0 | 10000 | 2 | 0 | INSUFFICIENT_SAMPLE |

## 8. Residual and recovery outcomes

- One-leg residuals: 0
- Unknown outcomes: 0
- Recovery attempts/dispositions: 0/0
- Paired settlements: 0

## 9. P&L and drawdown

- Realized P&L6: 0
- Unresolved worst-case P&L6: 0
- Conservative total P&L6: 0
- Maximum drawdown6: 0
- Peak capital at risk6: 0

## 10. Data-quality exclusions

| Code | Count | Detail |
|---|---:|---|
| SYNTHETIC_VALIDATION_ONLY | 0 | No empirical markets, days, episodes, or opportunities are present. |

## 11. Sensitivity and limitations

- Primary UTC-day interval: INSUFFICIENT_SAMPLE
- Market sensitivity interval: INSUFFICIENT_SAMPLE
- Synthetic validation-only artifact; it is not empirical evidence and cannot promote paper scheduling.

## 12. Promotion-gate verdict

Verdict: **REMAIN_OBSERVER_ONLY**. Live capability: **false**.

| Gate | Passed | Evidence |
|---|---:|---|
| GATE_01_SAMPLE_SUFFICIENCY | NO | 0 UTC days; 0 activation candidates |
| GATE_02_DATA_INTEGRITY | NO | 0 reconciliation mismatches; 0 unexplained integrity mismatches; 0 fee and 0 constraint snapshots |
| GATE_03_POSITIVE_TOTAL_NET_PNL | NO | 0 conservative pnl6 |
| GATE_04_POSITIVE_CLUSTERED_LOWER_BOUND | NO | INSUFFICIENT_SAMPLE |
| GATE_05_BOTH_SERIAL_ORDERS_POSITIVE | NO | 4 UP-first and 4 DOWN-first comparisons |
| GATE_06_DEFAULT_AND_2X_P95_POSITIVE | NO | baseline:0, latency_2x_p95:0 |
| GATE_07_CAPTURE_AGE_SKEW | NO | age/skew evidence failed or missing |
| GATE_08_ONE_TICK_STRESS_POSITIVE | NO | 0 |
| GATE_09_OPERATIONAL_NOTIONAL | NO | 0 measured notional6 vs 1 threshold6 |
| GATE_10_HUMAN_REVIEW | NO | not completed |

## 13. Reproduction hashes and commands

- Scenario matrix hash: `192f609110f9d071ce94090c79c7ea3e1667470bb0e5bb053cc5f8e0176ff45e`
- Scenario run hash: `25c836ef25f30e1a505c3fe1402d1c695bf36efd3248240541b6600f655c22c7`
- Statistics hashes: `0beaa68f6342bbbdcad3b2f7e34c8788a6d3d1e7dd46acf950158325e066021e`, `0dbaae920d4cc49be3a4f86858c54f8119d5c88b303e32219aab35baabf61c57`, `217cedadc9a68d68d251dee54dadff15eeea32bcf0e08b4b8c75662c0e4548f0`, `22ec508895d2b4f9dc8dee3dd0f72d98f152e3e1004f982990d2aed628d1eb46`, `313835f88fbb1f1b60b28ddca67f522254496c42d8f0ee36c76d678f1d32d3cf`, `3d54c2b1f556ccfee1efcf6f4e4a58e562d5fe2c5ee351a450836125382a7104`, `3d876253543bdc4771e11eb13a24421c89cbb127365283fe2c042d65c1d30b0e`, `3e1830bf9f9ad4ed52bab327a65622ef9ca96e695c0f32367a32cc9be2a73d58`, `52c73aadc0ffa222481593e7da18b9360e2c4f68228b9f1f21463ab346c1e151`, `5736260754f21c496bafec48630a2d6771a88031b72267092acd8af75ce224d8`, `6dc420ff43b33cd369da80c3db663512c481d1464705492135ac3718ca408622`, `6f92890372f4e28595613b1fe9f6f113d67aa25dad7ddecdd480f0885e407d92`, `721783084b2ee227a5565ee03f7de94a1430449b6c8d61ed7cc0e1779b9150b8`, `a0de3ce0d0c7d1caa37b5ec7dc33a13d8d1729aeb223069ea131ba3fdf8b13e4`, `a23c0a62e6e1d3221861bca83ae015da7a86d87f032e9eec832096875f9d1bae`, `a2b9f0a60459f626de26d809e3f4c036add4154e052acd9bec173d3200c4a25c`, `aec92d3e7c27633bc9eefda9ef150680d0d3c85a85ac63606b632fbfda5adafb`, `b71cfe91fcf62764dbfcc460e001e281d568d529dfb5d67c7dfc2f04f4db2661`, `bde38178b80b545304eefe58adfbd18269b24565dc4cf641f4fc1bc168b3f4f2`, `bf36c2acb838aa25116f3a02ed542684f8fabe94f767eb2321c3fa019c1b7a7a`, `c8c788328381c77967319d93e2f892260e2d6d5fad79fdbeca7c239b53848045`, `c8ebbe5839d20397548f268c69d4613d406ae95b63bb1c607349341ae329ef78`, `ca0b946e21bf51c2afa06bbd3291c72ee110e956b55daafdb20536a28e8b7cae`, `d2eb59ea48811eba16f03be8453f344aa96ef9be3674836e01175bb0e0f4b1b4`, `ebcf2884e927c31cd90557ac41cccba983afd00a1d86f50f090d6de923bcae0a`, `eed7186a439c35cd708d66c070ffef7ecc138a298c37ab747fdaa708d16bf3e6`, `ff6b60c2ae7b7a7994701b0ee8194ff1e37e52b05a278895175f5044245f3744`, `ffc8ca52ea42b28d04b58243b963a0d965355e86ef08d5647956624131ba41b8`
- Config hashes: `fdf3066f0f6362cfa5a6fb2208cd5cc770d94669616ee1a67add067c391dc7c3` / `37f91ee84fd60507989d93cd57f269f5b7cd51c706259900a729c8aa7c7734c7`
- Provenance hash: `bfbb64c8a7a6e6318fe26b68ea105553af2bc0da6ef355d2ccd81f7e5f5365cb`
- Algorithms: `R7_LINEAR_H_EQUALS_N_MINUS_1_TIMES_P`, `deterministic_percentile_cluster_bootstrap_v1`, `pair_episode_statistics_v1`, `pcg32_v1`, `wilson_fixed_point_36_v1`
- Algorithm-set hash: `390047e679f2c139aaa34ebd856f675fa2598f0c60177c308117409d4302cddc`

Reproduce:

    pnpm --filter @b5p/research report:pairs:zero
