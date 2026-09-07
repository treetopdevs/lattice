"""Private parser tests run on every host; actual mutation tests require Linux."""
import base64
import importlib.util
import json
from pathlib import Path
import unittest
import sys
sys.dont_write_bytecode = True

HELPER = Path(__file__).resolve().parents[4] / "scripts/treehouse_operator_mutation.py"
spec = importlib.util.spec_from_file_location("mutation", HELPER)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)


class Protocol(unittest.TestCase):
    def sample(self):
        return {"version": 1, "phase": "carrier_pending",
                "attempt": base64.urlsafe_b64encode(bytes(32)).decode().rstrip("="),
                "generation": 0, "catalog_head": None, "manifest_digest": "0" * 64,
                "artifacts": [{"path": "/public/candidate", "sha256": "1" * 64,
                               "kind": "manifest", "replica": None, "op_id": None, "review": None}]}

    def test_duplicate_keys_after_escapes_and_constants_refuse(self):
        for raw in ['{"version":1,"version":2}', '{"version":1,"ver\\u0073ion":2}',
                    '{"n":NaN}', '{"n":Infinity}']:
            with self.assertRaises(owner.Refusal):
                owner.decode(raw)

    def test_closed_record_exact_integer_and_horizon(self):
        self.assertEqual(owner.record(json.dumps(self.sample())), self.sample())
        for key, value in [("generation", True), ("generation", 1.0),
                           ("generation", 9007199254740991), ("extra", None),
                           ("version", True)]:
            record = self.sample()
            record[key] = value
            with self.assertRaises(owner.Refusal):
                owner.record(json.dumps(record))

    def test_raw_binary_canonical_and_bounded(self):
        self.assertEqual(owner.binary("eA=="), b"x")
        for value in ["eA", "eA==\n", "eB==", "", True]:
            with self.assertRaises(owner.Refusal):
                owner.binary(value)

    def test_large_record_and_unknown_artifact_field_refuse(self):
        record = self.sample()
        record["artifacts"][0]["unreviewed"] = "x"
        with self.assertRaises(owner.Refusal):
            owner.record(json.dumps(record))
        with self.assertRaises(owner.Refusal):
            owner.record(" " * (owner.MAX_JOURNAL + 1))


if __name__ == "__main__":
    unittest.main()
