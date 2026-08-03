#!/usr/bin/env python3
"""Deterministic synthetic mini-corpus for the repro harness CI tests.

Schema-identical (column-wise) to the kachoio corpus but tiny: 48 contiguous
5-minute windows across 2 UTC days, 5-second top-of-book ticks, favored-side
mid drifting toward the known outcome with seeded noise. Committed to git so
CI runs end-to-end WITHOUT the real dataset; regeneration is byte-stable
(seed 7, fixed rounding).

Regenerate:  .venv/bin/python fixtures/gen_repro_smoke.py
"""
from __future__ import annotations

import os

import numpy as np

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "repro_smoke")
BASE_EPOCH = 1_770_000_000  # divisible by 300; two UTC days of windows
N_MARKETS = 48
TICK_STEP = 5

rng = np.random.default_rng(7)

# outcomes: seeded coin flips with three injected runs of >=5 same direction
outcomes = list((rng.random(N_MARKETS) < 0.5).astype(int))
for start, val in [(6, 1), (20, 0), (33, 1)]:
    for j in range(start, start + 5):
        outcomes[j] = val

markets = ["condition_id,market_start,market_end,outcome"]
ticks = ["condition_id,t,bu,au,bd,ad,su,sd,sau,sad,du,dd"]

for i in range(N_MARKETS):
    # markets on the second half-day boundary split across 2 days
    start = BASE_EPOCH + 300 * i if i < 24 else BASE_EPOCH + 86_400 + 300 * (i - 24)
    end = start + 300
    cid = f"0xsmoke{i:04d}"
    y = outcomes[i]
    markets.append(f"{cid},{start},{end},{'Up' if y else 'Down'}")

    # UP mid path: 0.5 -> outcome with noise and a mid-window pullback
    n_ticks = 300 // TICK_STEP
    target = 0.97 if y else 0.03
    for k in range(n_ticks):
        t = start + TICK_STEP * (k + 1)
        frac = (k + 1) / n_ticks
        drift = 0.5 + (target - 0.5) * frac ** 1.3
        noise = float(rng.normal(0, 0.035))
        pullback = -0.12 * (1 if y else -1) * np.exp(-((frac - 0.45) ** 2) / 0.004)
        mid = min(0.98, max(0.02, drift + noise + pullback))
        bu = round(max(0.01, mid - 0.01), 2)
        au = round(min(0.99, mid + 0.01), 2)
        bd = round(max(0.01, 1 - au), 2)
        ad = round(min(0.99, 1 - bu), 2)
        su = round(float(rng.uniform(50, 500)), 1)
        sd = round(float(rng.uniform(50, 500)), 1)
        sau = round(float(rng.uniform(50, 500)), 1)
        sad = round(float(rng.uniform(50, 500)), 1)
        du = round(float(rng.uniform(500, 5000)), 1)
        dd = round(float(rng.uniform(500, 5000)), 1)
        ticks.append(f"{cid},{t},{bu},{au},{bd},{ad},{su},{sd},{sau},{sad},{du},{dd}")

os.makedirs(OUT_DIR, exist_ok=True)
with open(os.path.join(OUT_DIR, "markets.csv"), "w") as fh:
    fh.write("\n".join(markets) + "\n")
with open(os.path.join(OUT_DIR, "ticks.csv"), "w") as fh:
    fh.write("\n".join(ticks) + "\n")
print(f"wrote {OUT_DIR}: {N_MARKETS} markets, {len(ticks) - 1} ticks")
