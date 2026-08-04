import unittest

import pandas as pd

from calibration_study import build_slice_features, minute_of_hour


class CalibrationStudyTest(unittest.TestCase):
    def test_diff_features_are_independent_of_input_row_order(self):
        ticks = pd.DataFrame(
            {
                "condition_id": ["market"] * 4,
                "t": [850, 880, 910, 940],
                "srem": [150, 120, 90, 60],
                "mid": [0.35, 0.40, 0.50, 0.52],
                "bu": [0.34, 0.39, 0.39, 0.51],
                "au": [0.36, 0.41, 0.61, 0.53],
                "ad": [0.66, 0.61, 0.51, 0.49],
                "bd": [0.64, 0.59, 0.49, 0.47],
                "su": [5.0] * 4,
                "sau": [3.0] * 4,
                "du": [8.0] * 4,
                "dd": [2.0] * 4,
                "y": [1] * 4,
                "day": ["2026-01-01"] * 4,
                "closing_minute": [5] * 4,
            }
        )

        ordered = build_slice_features(ticks, 60)
        shuffled = build_slice_features(ticks.sample(frac=1, random_state=7), 60)

        self.assertAlmostEqual(ordered.loc["market", "vol60"], 0.04)
        self.assertEqual(ordered.loc["market", "flips60"], 1)
        pd.testing.assert_series_equal(ordered["vol60"], shuffled["vol60"])
        pd.testing.assert_series_equal(ordered["flips60"], shuffled["flips60"])

    def test_bonferroni_uses_number_of_minute_groups(self):
        markets = pd.DataFrame(
            {
                "closing_minute": [0, 0, 5, 5, 7, 7],
                "y": [1, 1, 0, 0, 1, 0],
            }
        )

        rows = minute_of_hour(markets)

        self.assertEqual(len(rows), 3)
        for row in rows:
            self.assertAlmostEqual(
                row["p_bonferroni"], min(1.0, row["p_raw"] * len(rows))
            )


if __name__ == "__main__":
    unittest.main()
