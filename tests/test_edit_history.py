"""Synthetic regression cases for the real review-history transformation."""
import unittest
from core.ocr_db import build_cell_diffs, canonicalize_field_name


class ReviewHistoryTests(unittest.TestCase):
    def test_changed_value_is_recorded_without_document_metadata(self):
        before = [{"row_index": 0, "C": "0.12", "title": "synthetic before"}]
        after = [{"C": "0.15", "title": "synthetic after"}]
        self.assertEqual(build_cell_diffs(before, after), [{
            "row_index": 0, "field_name": "C", "old_value": "0.12",
            "new_value": "0.15", "action": "update"}])

    def test_added_and_removed_rows_preserve_audit_actions(self):
        self.assertEqual(build_cell_diffs([], [{"C": "0.12"}])[0]["action"], "insert")
        self.assertEqual(build_cell_diffs([{"row_index": 0, "C": "0.12"}], [])[0]["action"], "delete")

    def test_unchanged_value_does_not_create_history(self):
        self.assertEqual(build_cell_diffs([{"row_index": 0, "C": "0.12"}], [{"C": "0.12"}]), [])

    def test_heat_number_alias_is_canonicalized(self):
        for name in ["Heat No", "Heat Number", "raw_heat_no"]:
            self.assertEqual(canonicalize_field_name(name), "heat_no")


if __name__ == "__main__":
    unittest.main()
