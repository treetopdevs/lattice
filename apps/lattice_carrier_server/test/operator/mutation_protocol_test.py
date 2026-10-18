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

    def test_only_pending_and_activated_phases_parse(self):
        for phase in ["carrier_pending", "activated"]:
            self.assertEqual(owner.record(json.dumps(dict(self.sample(), phase=phase)))["phase"], phase)
        for phase in ["ready", "Activated", None, 1]:
            with self.assertRaises(owner.Refusal, msg=repr(phase)):
                owner.record(json.dumps(dict(self.sample(), phase=phase)))

    def test_activation_plan_shape_is_closed(self):
        pending = json.dumps(self.sample())
        activated = json.dumps(dict(self.sample(), phase="activated"))
        good = {"version": 1, "kind": "activate", "expected": pending, "record": activated,
                "attempt": self.sample()["attempt"], "artifacts": None, "incarnation": "4" * 64,
                "checks": [{"path": "/srv/active.json", "sha256": "0" * 64},
                           {"path": "/srv/space.log", "sha256": "4" * 64}]}
        log = good["checks"][1]
        malformed = [dict(good, artifacts=[]), dict(good, checks=[]),
                     dict(good, incarnation=None), dict(good, incarnation="4" * 63),
                     dict(good, incarnation="G" * 64), dict(good, incarnation="4" * 65),
                     dict(good, checks=good["checks"][:1]),
                     dict(good, checks=[log, log]), dict(good, attempt="short"),
                     dict(good, checks=[{"path": "relative.json", "sha256": "0" * 64}, log]),
                     dict(good, checks=[{"path": "/srv/../active.json", "sha256": "0" * 64}, log]),
                     dict(good, checks=[good["checks"][0], dict(log, path="space.log")])]
        stale = [dict(good, checks=[{"path": "/srv/active.json", "sha256": "3" * 64}, log]),
                 dict(good, expected=activated),
                 dict(good, record=json.dumps(dict(self.sample(), phase="activated", generation=1))),
                 dict(good, record=pending)]
        for plan, reason in [(p, "malformed_operator_plan") for p in malformed] + \
                [(p, "stale_operator_intent") for p in stale]:
            with self.assertRaises(owner.Refusal, msg=repr(plan)) as caught:
                owner.activate("/nonexistent-root", plan)
            self.assertEqual(str(caught.exception), reason)

    def test_candidate_paths_must_be_absolute(self):
        def manifest(**paths):
            entry = dict({"identity_file": "/srv/a.identity", "log_file": "/srv/a.log"}, **paths)
            return json.dumps({"version": 1, "instances": [entry]}).encode()
        owner.absolute_paths(manifest(), "/nonexistent-root")
        for bad in [manifest(identity_file="a.identity"), manifest(log_file="../a.log"),
                    manifest(log_file="/srv/../a.log"), manifest(log_file=None),
                    b'{"version":1}', b"not json", b"\xff"]:
            with self.assertRaises(owner.Refusal, msg=repr(bad)) as caught:
                owner.absolute_paths(bad, "/nonexistent-root")
            self.assertEqual(str(caught.exception), "unsafe_candidate_manifest")

    def test_activation_never_replaces_its_lock_journal_or_artifacts(self):
        names = owner.reserved("/op", self.sample())
        self.assertEqual(names, {"/op/operator.lock", "/op/operator-journal.json",
                                 "/op/operator-incarnation", "/op/operator-journal-history.jsonl",
                                 "/public/candidate"})

    def test_boot_plan_shape_is_closed(self):
        good = {"version": 1, "kind": "boot", "expected": None, "record": None, "attempt": None,
                "artifacts": None, "incarnation": None,
                "checks": [{"path": "/srv/active.json", "sha256": "0" * 64}]}
        for plan in [dict(good, expected=json.dumps(self.sample())), dict(good, record="{}"),
                     dict(good, attempt=self.sample()["attempt"]), dict(good, artifacts=[]),
                     dict(good, incarnation="4" * 64), dict(good, checks=None), dict(good, checks=[]),
                     dict(good, checks=good["checks"] * 2),
                     dict(good, checks=[{"path": "/srv/active.json", "sha256": "short"}]),
                     dict(good, checks=[{"path": "relative.json", "sha256": "0" * 64}])]:
            with self.assertRaises(owner.Refusal, msg=repr(plan)) as caught:
                owner.boot("/nonexistent-root", plan)
            self.assertEqual(str(caught.exception), "malformed_operator_plan")

    def test_only_boot_and_activate_plans_carry_an_incarnation(self):
        plan = {"version": 1, "kind": "journal", "expected": None, "record": "{}", "attempt": None,
                "checks": None, "artifacts": None, "incarnation": "4" * 64}
        with self.assertRaises(owner.Refusal) as caught:
            owner.execute("/nonexistent-root", plan)
        self.assertEqual(str(caught.exception), "malformed_operator_plan")
        # A well-formed stage plan, so only the incarnation guard can refuse it
        # as malformed; without one it gets past validation to the root check.
        raw = b"candidate"
        stage = dict(plan, kind="stage", record=None, attempt=self.sample()["attempt"],
                     checks=[{"path": "/srv/active.json", "sha256": "2" * 64}],
                     artifacts=[{"sha256": owner.digest(raw),
                                 "bytes": base64.b64encode(raw).decode()}])
        with self.assertRaises(owner.Refusal) as caught:
            owner.execute("/nonexistent-root", stage)
        self.assertEqual(str(caught.exception), "malformed_operator_plan")
        with self.assertRaises(Exception) as caught:
            owner.execute("/nonexistent-root", dict(stage, incarnation=None))
        self.assertNotEqual(str(caught.exception), "malformed_operator_plan")

    def test_boot_without_journal_writes_a_fresh_private_marker(self):
        root = self.workdir("boot-marker")
        manifest = os.path.join(root, "active.json")
        with open(manifest, "wb") as f:
            f.write(b"{}")
        os.chmod(manifest, 0o600)
        plan = {"version": 1, "kind": "boot", "expected": None, "record": None, "attempt": None,
                "artifacts": None, "incarnation": None,
                "checks": [{"path": manifest, "sha256": owner.digest(b"{}")}]}
        markers = []
        for _ in range(2):
            with mock.patch.object(owner, "reply") as reply:
                owner.boot(root, plan)
            marker = reply.call_args[0][0]["incarnation"]
            markers.append(marker)
            path = os.path.join(root, "operator-incarnation")
            with open(path, "rb") as f:
                self.assertEqual(f.read(), marker.encode())
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertTrue(all(len(m) == 64 and set(m) <= set("0123456789abcdef") for m in markers))
        self.assertNotEqual(markers[0], markers[1])
        self.assertEqual([n for n in os.listdir(root) if ".tmp." in n], [])

    def test_boot_without_journal_still_rechecks_the_loaded_manifest(self):
        root = self.workdir("boot-stale")
        manifest = os.path.join(root, "active.json")
        with open(manifest, "wb") as f:
            f.write(b"{}")
        os.chmod(manifest, 0o600)
        plan = {"version": 1, "kind": "boot", "expected": None, "record": None, "attempt": None,
                "artifacts": None, "incarnation": None,
                "checks": [{"path": manifest, "sha256": owner.digest(b"[]")}]}
        for target, reason in [(manifest, "stale_operator_intent"),
                               (os.path.join(root, "missing.json"), "stale_operator_intent"),
                               (os.path.join(root, "operator-incarnation"), "unsafe_operator_file")]:
            with self.assertRaises(owner.Refusal) as caught:
                owner.boot(root, dict(plan, checks=[dict(plan["checks"][0], path=target)]))
            self.assertEqual(str(caught.exception), reason)
        self.assertFalse(os.path.exists(os.path.join(root, "operator-incarnation")))

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


    # Rows 218 and 219: journal history and activation permission bits.

    def private(self, path, raw, mode=0o600):
        with open(path, "wb") as f:
            f.write(raw)
        os.chmod(path, mode)
        return path

    def compact(self, value):
        return json.dumps(value, separators=(",", ":"))

    def history_bytes(self, root):
        path = os.path.join(root, owner.HISTORY)
        if not os.path.exists(path):
            return None
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        with open(path, "rb") as f:
            return f.read()

    def journal(self, root):
        with open(os.path.join(root, "operator-journal.json"), "rb") as f:
            return f.read().decode()

    def pending(self, root, n=0, artifacts=None, manifest_digest="0" * 64):
        identity = os.path.join(root, "service.identity")
        if not os.path.exists(identity):
            self.private(identity, b"a" * 64)
        record = self.sample()
        record["attempt"] = base64.urlsafe_b64encode(bytes([n]) * 32).decode().rstrip("=")
        record["manifest_digest"] = manifest_digest
        record["artifacts"] = artifacts or [dict(record["artifacts"][0], path=os.path.join(root, "candidate"))]
        record["service"].update(identity_file=identity, sha256=owner.digest(b"a" * 64))
        return record

    def test_journal_plan_appends_the_replaced_bytes_but_first_creation_does_not(self):
        root = self.workdir("history-journal")
        first = self.compact(self.pending(root, 0))
        second = self.compact(self.pending(root, 1))
        third = self.compact(self.pending(root, 2))
        owner.commit(root, None, first)
        self.assertIsNone(self.history_bytes(root))
        plan = {"version": 1, "kind": "journal", "expected": first, "record": second, "attempt": None,
                "checks": None, "artifacts": None, "incarnation": None}
        with mock.patch.object(owner, "reply"):
            owner.execute(root, plan)
            self.assertEqual(self.history_bytes(root), first.encode() + b"\n")
            owner.execute(root, dict(plan, expected=second, record=third))
        self.assertEqual(self.history_bytes(root), (first + "\n" + second + "\n").encode())
        self.assertEqual(self.journal(root), third)

    def test_stage_over_an_existing_journal_appends_the_replaced_bytes(self):
        root = self.workdir("history-stage")
        first = self.compact(self.pending(root, 0))
        owner.commit(root, None, first)
        snapshot = self.private(os.path.join(root, "active.json"), b"{}")
        raw = b"candidate"
        attempt = self.pending(root, 1)["attempt"]
        attempt_dir = os.path.join(root, "attempt-" + owner.digest(attempt.encode()))
        artifact = dict(self.sample()["artifacts"][0], path=os.path.join(attempt_dir, owner.digest(raw)),
                        sha256=owner.digest(raw))
        second = self.compact(self.pending(root, 1, artifacts=[artifact]))
        plan = {"version": 1, "kind": "stage", "expected": first, "record": None, "attempt": attempt,
                "checks": [{"path": snapshot, "sha256": owner.digest(b"{}")}], "incarnation": None,
                "artifacts": [{"sha256": owner.digest(raw), "bytes": base64.b64encode(raw).decode()}]}
        with mock.patch.object(owner, "reply"), \
                mock.patch.object(owner, "line", return_value={"commit": second}):
            owner.execute(root, plan)
        self.assertEqual(self.history_bytes(root), first.encode() + b"\n")
        self.assertEqual(self.journal(root), second)

    def activation(self, name, mode=0o600, already_active=False):
        """A pending attempt whose staged candidate is ready to activate."""
        root = self.workdir(name)
        old = b'{"version":1,"instances":[]}'
        candidate = self.compact({"version": 1, "instances": [
            {"identity_file": "/srv/a.identity", "log_file": "/srv/a.log"}]}).encode()
        target = self.private(os.path.join(root, "active.json"), candidate if already_active else old, mode)
        os.mkdir(os.path.join(root, "attempt"), 0o700)
        staged = self.private(os.path.join(root, "attempt", owner.digest(candidate)), candidate)
        log = self.private(os.path.join(root, "space.log"), b"log")
        self.private(os.path.join(root, owner.INCARNATION), b"4" * 64)
        artifact = dict(self.sample()["artifacts"][0], path=staged, sha256=owner.digest(candidate))
        record = self.pending(root, 0, artifacts=[artifact], manifest_digest=owner.digest(old))
        pending = self.compact(record)
        owner.commit(root, None, pending)
        plan = {"version": 1, "kind": "activate", "expected": pending,
                "record": self.compact(dict(record, phase="activated")), "attempt": record["attempt"],
                "artifacts": None, "incarnation": "4" * 64,
                "checks": [{"path": target, "sha256": owner.digest(old)},
                           {"path": log, "sha256": owner.digest(b"log")}]}
        return root, target, old, candidate, plan

    def test_activation_appends_history_and_keeps_the_manifest_mode(self):
        for mode in (0o644, 0o600):
            root, target, _, candidate, plan = self.activation("activate-{:o}".format(mode), mode)
            with mock.patch.object(owner, "reply"):
                owner.activate(root, plan)
            with open(target, "rb") as f:
                self.assertEqual(f.read(), candidate)
            self.assertEqual(stat.S_IMODE(os.stat(target).st_mode), mode)
            self.assertEqual(self.history_bytes(root), plan["expected"].encode() + b"\n")
            self.assertEqual(self.journal(root), plan["record"])
            self.assertEqual([n for n in os.listdir(root) if ".activate." in n], [])

    def test_activation_refuses_a_group_writable_active_manifest(self):
        root, target, old, _, plan = self.activation("activate-shared", 0o600)
        os.chmod(target, 0o664)
        with self.assertRaises(owner.Refusal) as caught:
            owner.activate(root, plan)
        self.assertEqual(str(caught.exception), "unsafe_operator_file")
        with open(target, "rb") as f:
            self.assertEqual(f.read(), old)
        self.assertIsNone(self.history_bytes(root))
        self.assertEqual(self.journal(root), plan["expected"])

    def test_activation_mode_check_refuses_a_group_writable_manifest(self):
        # active() already refuses one before mode_of() runs; this pins the
        # mode capture's own guard, so it cannot copy a shared mode alone.
        root = self.workdir("mode-of")
        path = self.private(os.path.join(root, "active.json"), b"{}", 0o644)
        self.assertEqual(owner.mode_of(path), 0o644)
        for mode in (0o664, 0o646):
            os.chmod(path, mode)
            with self.assertRaises(owner.Refusal) as caught:
                owner.mode_of(path)
            self.assertEqual(str(caught.exception), "unsafe_operator_file")

    def test_boot_reconcile_appends_history_and_a_noop_boot_does_not(self):
        root, target, old, candidate, plan = self.activation("boot-noop")
        boot = {"version": 1, "kind": "boot", "expected": None, "record": None, "attempt": None,
                "artifacts": None, "incarnation": None,
                "checks": [{"path": target, "sha256": owner.digest(old)}]}
        with mock.patch.object(owner, "reply"):
            owner.boot(root, boot)
        self.assertIsNone(self.history_bytes(root))
        self.assertEqual(self.journal(root), plan["expected"])

        root, target, _, candidate, plan = self.activation("boot-reconcile", already_active=True)
        with mock.patch.object(owner, "reply"):
            owner.boot(root, dict(boot, checks=[{"path": target, "sha256": owner.digest(candidate)}]))
        self.assertEqual(self.history_bytes(root), plan["expected"].encode() + b"\n")
        self.assertEqual(self.journal(root), plan["record"])

    def test_unsafe_history_file_refuses_before_the_journal_moves(self):
        for name in ("symlink", "group-readable", "hardlink"):
            root = self.workdir("history-" + name)
            first = self.compact(self.pending(root, 0))
            owner.commit(root, None, first)
            history = os.path.join(root, owner.HISTORY)
            other = self.private(os.path.join(root, "other"), b"")
            if name == "symlink":
                os.symlink(other, history)
            elif name == "group-readable":
                self.private(history, b"", 0o640)
            else:
                os.link(other, history)
            with self.assertRaises(owner.Refusal, msg=name) as caught:
                owner.commit(root, first, self.compact(self.pending(root, 1)))
            self.assertEqual(str(caught.exception), "unsafe_operator_file")
            self.assertEqual(self.journal(root), first)
            with open(other, "rb") as f:
                self.assertEqual(f.read(), b"")


    def test_a_torn_history_tail_is_cut_back_before_the_next_append(self):
        root = self.workdir("history-torn")
        first = self.compact(self.pending(root, 0))
        second = self.compact(self.pending(root, 1))
        owner.commit(root, None, first)
        self.private(os.path.join(root, owner.HISTORY), b'old\n{"version":1,"pha')
        owner.commit(root, first, second)
        self.assertEqual(self.history_bytes(root), b"old\n" + first.encode() + b"\n")
        self.assertEqual(self.journal(root), second)

    def test_a_failed_history_write_is_cut_back_and_the_journal_stays(self):
        root = self.workdir("history-enospc")
        first = self.compact(self.pending(root, 0))
        owner.commit(root, None, first)
        self.private(os.path.join(root, owner.HISTORY), b"old\n")
        real = os.write
        calls = []

        def partial(fd, data):
            # One short write lands, then the disk is full.
            calls.append(len(data))
            if len(calls) == 1:
                return real(fd, data[:7])
            raise OSError(28, "No space left on device")

        with mock.patch.object(owner.os, "write", side_effect=partial):
            with self.assertRaises(owner.Refusal) as caught:
                owner.commit(root, first, self.compact(self.pending(root, 1)))
        self.assertEqual(str(caught.exception), "operator_history_write_failed")
        self.assertEqual(self.history_bytes(root), b"old\n")
        self.assertEqual(self.journal(root), first)

    def test_an_unsafe_history_file_refuses_activation_before_the_manifest_moves(self):
        root, target, old, _, plan = self.activation("activate-unsafe-history")
        other = self.private(os.path.join(root, "other"), b"")
        os.symlink(other, os.path.join(root, owner.HISTORY))
        with self.assertRaises(owner.Refusal) as caught:
            owner.activate(root, plan)
        self.assertEqual(str(caught.exception), "unsafe_operator_file")
        with open(target, "rb") as f:
            self.assertEqual(f.read(), old)
        self.assertEqual(self.journal(root), plan["expected"])

    def test_activation_never_copies_special_mode_bits(self):
        root, target, _, _, plan = self.activation("activate-sticky", 0o644)
        os.chmod(target, 0o1644)
        self.assertEqual(owner.mode_of(target), 0o644)

    def test_a_deployment_path_naming_an_operator_file_refuses(self):
        root = self.workdir("collision")
        history = os.path.join(root, owner.HISTORY)
        manifest = json.dumps({"version": 1, "instances": [
            {"identity_file": history, "log_file": "/srv/a.log"}]}).encode()
        with self.assertRaises(owner.Refusal) as caught:
            owner.absolute_paths(manifest, root)
        self.assertEqual(str(caught.exception), "operator_path_collision")
        # A hard link to the history file is the same file under another name.
        self.private(history, b"")
        alias = os.path.join(root, "alias.identity")
        os.link(history, alias)
        with self.assertRaises(owner.Refusal) as caught:
            owner.apart(root, alias)
        self.assertEqual(str(caught.exception), "operator_path_collision")

    def test_a_journal_naming_an_operator_file_as_its_service_identity_refuses(self):
        root = self.workdir("collision-service")
        history = self.private(os.path.join(root, owner.HISTORY), b"a" * 64)
        record = self.pending(root, 0)
        record["service"].update(identity_file=history)
        with mock.patch.object(owner, "current_service"):
            with self.assertRaises(owner.Refusal) as caught:
                owner.commit(root, None, self.compact(record))
        self.assertEqual(str(caught.exception), "operator_path_collision")
        self.assertFalse(os.path.exists(os.path.join(root, "operator-journal.json")))
        with open(history, "rb") as f:
            self.assertEqual(f.read(), b"a" * 64)

    def test_short_history_reads_never_skip_unread_bytes(self):
        root = self.workdir("history-short-read")
        path = self.private(os.path.join(root, "h"), b"one\ntwo\nfrag")
        fd = os.open(path, os.O_RDONLY)
        real = os.pread
        try:
            # Every read returns at most two bytes.
            with mock.patch.object(owner.os, "pread", side_effect=lambda f, n, o: real(f, min(n, 2), o)):
                self.assertEqual(owner.complete_lines(fd, os.fstat(fd).st_size), 8)
        finally:
            os.close(fd)

if __name__ == "__main__":
    unittest.main()
