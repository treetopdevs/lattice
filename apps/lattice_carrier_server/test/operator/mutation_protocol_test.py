"""Private parser tests run on every host; actual mutation tests require Linux."""
import base64
import importlib.util
import json
import os
import shutil
import stat
from pathlib import Path
from unittest import mock
import unittest
import sys
sys.dont_write_bytecode = True

HELPER = Path(__file__).resolve().parents[4] / "scripts/treehouse_operator_mutation.py"
spec = importlib.util.spec_from_file_location("mutation", HELPER)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)


class Protocol(unittest.TestCase):
    # `directory()` refuses any ancestor that is group/other-writable (the
    # system temp dir on most hosts is world-writable, e.g. /tmp at 1777), so
    # a scratch dir for these tests lives under the checkout itself, exactly
    # like the Elixir operator fixtures do.
    def workdir(self, name):
        path = Path(__file__).resolve().parent / ".py-mutation-{}-{}".format(name, os.getpid())
        shutil.rmtree(path, ignore_errors=True)
        path.mkdir(mode=0o700)
        self.addCleanup(shutil.rmtree, path, ignore_errors=True)
        return str(path)

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

    def test_fifo_open_does_not_block_the_lock_owner(self):
        # No writer will ever open the other end of this FIFO. Without
        # O_NONBLOCK on the read-only open, this call hangs forever instead
        # of reaching the S_ISREG check and refusing.
        d = self.workdir("fifo")
        fifo = os.path.join(d, "fifo")
        os.mkfifo(fifo)
        with self.assertRaises(owner.Refusal) as ctx:
            owner.file_bytes(fifo)
        self.assertEqual(str(ctx.exception), "unsafe_operator_file")

    def test_root_owned_file_permitted_only_when_snapshot_input(self):
        d = self.workdir("root-owned")
        path = os.path.join(d, "snapshot")
        payload = b"payload"
        with open(path, "wb") as f:
            f.write(payload)
        os.chmod(path, 0o600)
        # A root-owned regular file otherwise identical to a real one: only
        # st_uid is faked (via fstat, which only file_bytes consults;
        # directory()'s own ownership walk uses the real lstat/geteuid and
        # is unaffected).
        real = os.stat(path)
        fake = os.stat_result((
            stat.S_IFREG | 0o600, real.st_ino, real.st_dev, 1, 0, real.st_gid,
            real.st_size, real.st_atime, real.st_mtime, real.st_ctime,
        ))
        with mock.patch("os.fstat", return_value=fake):
            # When the test itself runs as root, uid 0 is indistinguishable
            # from "self" and the refusal below would be trivially true for
            # the wrong reason, so only assert it when it is meaningful.
            if os.geteuid() != 0:
                with self.assertRaises(owner.Refusal) as ctx:
                    owner.file_bytes(path)
                self.assertEqual(str(ctx.exception), "unsafe_operator_file")
            self.assertEqual(owner.file_bytes(path, allow_root=True), payload)

    def test_snapshot_missing_leaf_or_ancestor_is_stale_not_persistence_failure(self):
        d = self.workdir("missing-snapshot")
        missing_leaf = os.path.join(d, "missing-snapshot")
        with self.assertRaises(owner.Refusal) as ctx:
            owner.snapshots([{"path": missing_leaf, "sha256": "0" * 64}])
        self.assertEqual(str(ctx.exception), "stale_operator_intent")

        missing_ancestor = os.path.join(d, "gone-{}".format(os.getpid()), "snapshot")
        with self.assertRaises(owner.Refusal) as ctx:
            owner.snapshots([{"path": missing_ancestor, "sha256": "0" * 64}])
        self.assertEqual(str(ctx.exception), "stale_operator_intent")


if __name__ == "__main__":
    unittest.main()
