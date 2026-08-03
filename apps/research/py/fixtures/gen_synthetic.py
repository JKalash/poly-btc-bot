#!/usr/bin/env python3
"""
Deterministic synthetic fixture for the trainer smoke test (no network, tiny).

One row per simulated 5-minute market over ~10 days. The label is drawn from a
probability that tracks the mid with mild miscalibration, so the pipeline has
real structure to fit and calibrate — this proves the PIPELINE works; it says
nothing about real markets and must never be promoted.

Writes fixtures/synthetic_smoke.csv next to this script.
"""
import os

import numpy as np
import pandas as pd

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "synthetic_smoke.csv")

def main():
    rng = np.random.default_rng(7)
    n = 900
    base_ms = 1_760_000_000_000
    rows = []
    for i in range(n):
        end_ms = base_ms + i * 16 * 60 * 1000  # one market every 16 minutes, ~10 days
        start_ms = end_ms - 90 * 1000          # decision at T-90s
        mid = float(np.clip(rng.beta(2, 2), 0.03, 0.97))
        spread = float(rng.uniform(0.008, 0.03))
        quarter = int(i % 3 == 0)
        # true probability: sharper than the mid (the model CAN learn something
        # here, unlike the real corpus) with a small quarter-hour tilt
        z = 3.0 * (mid - 0.5) + 0.15 * quarter + rng.normal(0, 0.15)
        p_true = 1.0 / (1.0 + np.exp(-z))
        y = int(rng.random() < p_true)
        rows.append({
            "id": f"syn-{i:04d}",
            "start_ms": start_ms,
            "end_ms": end_ms,
            "y": y,
            "mid": round(mid, 6),
            "spread": round(spread, 6),
            "dist_half": round(mid - 0.5, 6),
            "quarter": quarter,
        })
    df = pd.DataFrame(rows)
    df.to_csv(OUT, index=False)
    print(f"written: {OUT} ({len(df)} rows, up-rate {df['y'].mean():.3f})")

if __name__ == "__main__":
    main()
