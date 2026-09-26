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
                               "kind": "manifest", "replica": None, "op_id": None, "review": None}],
                "service": {"identity_file": "/srv/child-service.identity", "realm": "child-service",
                            "pub": base64.b64encode(bytes(32)).decode(), "sha256": "2" * 64}}

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

    def test_service_identity_binding_is_closed_and_canonical(self):
        good = self.sample()["service"]
        for bad in [None, dict(good, extra="x"), {k: v for k, v in good.items() if k != "pub"},
                    dict(good, identity_file="relative/child.identity"),
                    dict(good, identity_file="/srv/../child.identity"), dict(good, realm=""),
                    dict(good, pub=base64.b64encode(b"short").decode()), dict(good, pub="not base64"),
                    dict(good, sha256="A" * 64)]:
            record = self.sample()
            record["service"] = bad
            with self.assertRaises(owner.Refusal, msg=repr(bad)):
                owner.record(json.dumps(record))
        record = self.sample()
        del record["service"]
        with self.assertRaises(owner.Refusal):
            owner.record(json.dumps(record))

    def committed(self, name, identity_bytes, bound_bytes):
        root = self.workdir(name)
        identity = os.path.join(root, "service.identity")
        if identity_bytes is not None:
            with open(identity, "wb") as f:
                f.write(identity_bytes)
            os.chmod(identity, 0o600)
        record = self.sample()
        record["artifacts"][0]["path"] = os.path.join(root, "candidate")
        record["service"]["identity_file"] = identity
        record["service"]["sha256"] = owner.digest(bound_bytes)
        owner.commit(root, None, json.dumps(record, separators=(",", ":")))
        return root

    def test_commit_rechecks_the_bound_service_identity_digest(self):
        root = self.committed("service-current", b"a" * 64, b"a" * 64)
        self.assertTrue(os.path.exists(os.path.join(root, "operator-journal.json")))
        for name, on_disk in [("service-rotated", b"b" * 64), ("service-missing", None)]:
            with self.assertRaises(owner.Refusal) as ctx:
                self.committed(name, on_disk, b"a" * 64)
            self.assertEqual(str(ctx.exception), "stale_operator_intent")

    def test_commit_refuses_a_symlinked_service_identity_cleanly(self):
        root = self.workdir("service-symlink")
        real = os.path.join(root, "real.identity")
        with open(real, "wb") as f:
            f.write(b"a" * 64)
        os.chmod(real, 0o600)
        link = os.path.join(root, "service.identity")
        os.symlink(real, link)
        record = self.sample()
        record["artifacts"][0]["path"] = os.path.join(root, "candidate")
        record["service"].update(identity_file=link, sha256=owner.digest(b"a" * 64))
        with self.assertRaises(owner.Refusal) as ctx:
            owner.commit(root, None, json.dumps(record, separators=(",", ":")))
        self.assertEqual(str(ctx.exception), "unsafe_operator_file")

    def test_commit_refuses_a_shared_service_identity_file(self):
        with self.assertRaises(owner.Refusal) as ctx:
            root = self.workdir("service-shared")
            identity = os.path.join(root, "service.identity")
            with open(identity, "wb") as f:
                f.write(b"a" * 64)
            os.chmod(identity, 0o640)
            record = self.sample()
            record["artifacts"][0]["path"] = os.path.join(root, "candidate")
            record["service"].update(identity_file=identity, sha256=owner.digest(b"a" * 64))
            owner.commit(root, None, json.dumps(record, separators=(",", ":")))
        self.assertEqual(str(ctx.exception), "unsafe_operator_file")

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
