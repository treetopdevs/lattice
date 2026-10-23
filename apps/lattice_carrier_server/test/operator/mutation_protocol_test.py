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

    CID = base64.urlsafe_b64encode(bytes([7]) * 32).decode().rstrip("=")
    ENVELOPE = b'{"catalog":"envelope"}'

    def catalog_artifact(self, root="/op", raw=None, **fields):
        sha = owner.digest(raw or self.ENVELOPE)
        return dict({"kind": "catalog", "op_id": self.CID, "replica": "space-1", "review": None,
                     "path": "{}/catalog/{}.json".format(root, sha), "sha256": sha}, **fields)

    def catalog_record(self, phase="catalogued", artifacts=1, head=CID, **fields):
        record = self.sample()
        record["artifacts"] += [self.catalog_artifact() for _ in range(artifacts)]
        if artifacts > 1:
            record["artifacts"][-1]["path"] = "/op/catalog/other.json"
        return dict(record, phase=phase, catalog_head=head, **fields)

    def test_catalog_artifact_and_phase_coupling(self):
        for phase in ("catalogued", "listed"):
            self.assertEqual(owner.record(json.dumps(self.catalog_record(phase)))["catalog_head"], self.CID)
        other = base64.urlsafe_b64encode(bytes([8]) * 32).decode().rstrip("=")
        bad = [self.catalog_record(artifacts=0), self.catalog_record(artifacts=2),
               self.catalog_record(head=None), self.catalog_record(head=other),
               self.catalog_record("ready"), self.catalog_record("activated"),
               self.catalog_record("carrier_pending"), self.catalog_record("ready", head=None)]
        for record in bad:
            with self.assertRaises(owner.Refusal, msg=repr(record)) as caught:
                owner.record(json.dumps(record))
            self.assertEqual(str(caught.exception), "corrupt_operator_journal")
        # A stage record after a listing keeps the committed head and no artifact.
        self.assertEqual(owner.record(json.dumps(dict(self.sample(), catalog_head=self.CID)))["catalog_head"],
                         self.CID)
        for fields in [{"review": {"creation": self.CID}}, {"op_id": None}, {"replica": ""}, {"replica": None},
                       {"op_id": "short"}, {"sha256": "G" * 64}, {"path": "relative"}, {"extra": 1}]:
            record = self.catalog_record()
            record["artifacts"][-1].update(fields)
            with self.assertRaises(owner.Refusal, msg=repr(fields)):
                owner.record(json.dumps(record))

    def test_catalogued_plan_shape_and_stale_refusals(self):
        root = "/nonexistent-root"
        sha = owner.digest(self.ENVELOPE)
        good = self.catalogued_plan(root)
        art = good["artifacts"][0]
        wrong_path = self.catalog_record(artifacts=1)
        wrong_path["artifacts"][-1]["path"] = "/elsewhere/{}.json".format(sha)
        malformed = [dict(good, artifacts=None), dict(good, artifacts=[]), dict(good, artifacts=[art, art]),
                     dict(good, artifacts=[dict(art, extra=1)]), dict(good, artifacts=[dict(art, sha256="3" * 64)]),
                     dict(good, artifacts=[dict(art, bytes="")]), dict(good, artifacts=[dict(art, bytes="eA")]),
                     dict(good, artifacts=[dict(art, bytes=base64.b64encode(b"x" * 131073).decode(),
                                                sha256=owner.digest(b"x" * 131073))]),
                     dict(good, checks=[]), dict(good, checks=good["checks"] * 2),
                     dict(good, incarnation=None), dict(good, incarnation="4" * 63), dict(good, attempt="short"),
                     dict(good, expected=None), dict(good, record=None),
                     dict(good, record=json.dumps(wrong_path))]
        for plan in malformed:
            with self.assertRaises(owner.Refusal, msg=repr(plan)) as caught:
                owner.catalogued(root, plan)
            self.assertEqual(str(caught.exception), "malformed_operator_plan")
        ready = json.loads(good["expected"])
        want = json.loads(good["record"])
        other = base64.urlsafe_b64encode(bytes([9]) * 32).decode().rstrip("=")
        stale = [dict(good, attempt=other),
                 dict(good, expected=self.compact(dict(ready, phase="activated"))),
                 dict(good, checks=[dict(good["checks"][0], sha256="3" * 64)]),
                 dict(good, record=self.compact(dict(want, generation=1))),
                 dict(good, record=self.compact(dict(want, phase="listed"))),
                 dict(good, record=self.compact(dict(self.catalog_record(artifacts=0), phase="ready"))),
                 dict(good, record=self.compact(dict(want, artifacts=want["artifacts"][-1:]))),
                 dict(good, record=self.compact(dict(want, service=dict(want["service"], realm="other"))))]
        for plan in stale:
            with self.assertRaises(owner.Refusal, msg=repr(plan)) as caught:
                owner.catalogued(root, plan)
            self.assertEqual(str(caught.exception), "stale_operator_intent")

    def test_listed_plan_shape_and_stale_refusals(self):
        root = "/nonexistent-root"
        good = self.listed_plan(root)
        malformed = [dict(good, artifacts=[]), dict(good, checks=[]), dict(good, incarnation=None),
                     dict(good, attempt="short"), dict(good, expected=None), dict(good, record=None)]
        for plan in malformed:
            with self.assertRaises(owner.Refusal, msg=repr(plan)) as caught:
                owner.listed(root, plan)
            self.assertEqual(str(caught.exception), "malformed_operator_plan")
        catalogued = json.loads(good["expected"])
        other = base64.urlsafe_b64encode(bytes([9]) * 32).decode().rstrip("=")
        stale = [dict(good, attempt=other), dict(good, expected=self.compact(dict(catalogued, phase="ready", catalog_head=None,
                                                      artifacts=catalogued["artifacts"][:1]))),
                 dict(good, checks=[dict(good["checks"][0], sha256="3" * 64)]),
                 dict(good, record=self.compact(dict(catalogued, phase="listed", generation=1))),
                 dict(good, record=good["expected"])]
        for plan in stale:
            with self.assertRaises(owner.Refusal, msg=repr(plan)) as caught:
                owner.listed(root, plan)
            self.assertEqual(str(caught.exception), "stale_operator_intent")

    def catalogued_plan(self, root, target="/srv/active.json", manifest="0" * 64):
        ready = dict(self.sample(), phase="ready")
        raw = self.compact(ready)
        want = dict(ready, phase="catalogued", catalog_head=self.CID,
                    artifacts=ready["artifacts"] + [self.catalog_artifact(root)])
        return {"version": 1, "kind": "catalogued", "expected": raw, "record": self.compact(want),
                "attempt": ready["attempt"], "incarnation": "4" * 64,
                "artifacts": [{"sha256": owner.digest(self.ENVELOPE),
                               "bytes": base64.b64encode(self.ENVELOPE).decode()}],
                "checks": [{"path": target, "sha256": ready["artifacts"][0]["sha256"]}]}

    def listed_plan(self, root, target="/srv/active.json"):
        record = json.loads(self.catalogued_plan(root)["record"])
        return {"version": 1, "kind": "listed", "expected": self.compact(record), "attempt": record["attempt"],
                "record": self.compact(dict(record, phase="listed")), "artifacts": None,
                "incarnation": "4" * 64,
                "checks": [{"path": target, "sha256": record["artifacts"][0]["sha256"]}]}

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

    def test_only_the_five_phases_parse(self):
        for phase in ["carrier_pending", "activated", "ready"]:
            self.assertEqual(owner.record(json.dumps(dict(self.sample(), phase=phase)))["phase"], phase)
        for phase in ["catalogued", "listed"]:
            self.assertEqual(owner.record(json.dumps(self.catalog_record(phase)))["phase"], phase)
        for phase in ["Ready", "Listed", "Catalogued", None, 1]:
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

    # Plan 223: the owner's ready phase.

    def activated(self, name):
        """An activated attempt (journal, manifest and marker on disk) and the plan that readies it."""
        root, target, _, candidate, plan = self.activation(name)
        with mock.patch.object(owner, "reply"):
            owner.activate(root, plan)
        activated = plan["record"]
        record = json.loads(activated)
        ready = {"version": 1, "kind": "ready", "expected": activated, "attempt": record["attempt"],
                 "record": self.compact(dict(record, phase="ready")), "artifacts": None,
                 "incarnation": "4" * 64, "checks": [{"path": target, "sha256": owner.digest(candidate)}]}
        return root, target, candidate, ready

    def refused(self, root, plan, reason, call=None):
        with self.assertRaises(owner.Refusal, msg=repr(plan)) as caught:
            (call or owner.ready)(root, plan)
        self.assertEqual(str(caught.exception), reason)

    def test_ready_plan_shape_is_closed(self):
        root, target, candidate, good = self.activated("ready-shape")
        check = good["checks"][0]
        other = dict(check, path="/srv/space.log")
        malformed = [dict(good, artifacts=[]), dict(good, checks=[]), dict(good, checks=[check, other]),
                     dict(good, checks=[dict(check, extra=1)]), dict(good, checks=[dict(check, sha256="G" * 64)]),
                     dict(good, checks=[dict(check, path="relative.json")]),
                     dict(good, checks=[dict(check, path="/srv/../active.json")]),
                     dict(good, incarnation=None), dict(good, incarnation="4" * 63),
                     dict(good, attempt="short"), dict(good, attempt=None), dict(good, expected=None),
                     dict(good, record=None)]
        for plan in malformed:
            with self.assertRaises(owner.Refusal, msg=repr(plan)) as caught:
                owner.execute(root, plan)
            self.assertEqual(str(caught.exception), "malformed_operator_plan")
        # The closed top-level keys are enforced by execute() for every kind.
        with self.assertRaises(owner.Refusal) as caught:
            owner.execute(root, dict(good, extra=None))
        self.assertEqual(str(caught.exception), "malformed_operator_plan")

    def test_ready_writes_phase_ready_and_appends_the_activated_bytes(self):
        root, target, candidate, plan = self.activated("ready-ok")
        before = self.history_bytes(root)
        with mock.patch.object(owner, "reply") as reply:
            owner.execute(root, plan)
        reply.assert_called_once_with({"ok": True})
        self.assertEqual(self.journal(root), plan["record"])
        self.assertEqual(self.history_bytes(root), before + plan["expected"].encode() + b"\n")
        with open(target, "rb") as f:
            self.assertEqual(f.read(), candidate)

    def test_ready_refusals_leave_journal_and_history_unchanged(self):
        root, target, candidate, good = self.activated("ready-refusals")
        record = json.loads(good["expected"])
        pending = self.compact(dict(record, phase="carrier_pending"))
        ready = json.loads(good["record"])
        other_attempt = base64.urlsafe_b64encode(bytes([9]) * 32).decode().rstrip("=")
        stale = [dict(good, attempt=other_attempt),
                 dict(good, record=self.compact(dict(ready, generation=1))),
                 dict(good, record=self.compact(dict(record, phase="activated"))),
                 dict(good, record=pending),
                 dict(good, expected=pending, record=self.compact(dict(record, phase="ready"))),
                 dict(good, expected=good["record"]),
                 dict(good, checks=[{"path": target, "sha256": "3" * 64}])]
        journal, history = self.journal(root), self.history_bytes(root)
        for plan in stale:
            self.refused(root, plan, "stale_operator_intent")
        # Equivalent JSON that is not the journal's exact bytes is stale, not corrupt.
        self.refused(root, dict(good, expected=good["expected"].replace("generation\":0", "generation\":0 ")),
                     "stale_operator_intent")
        self.refused(root, dict(good, incarnation="5" * 64), "stale_operator_incarnation")
        self.private(os.path.join(root, owner.INCARNATION), b"5" * 64)
        self.refused(root, good, "stale_operator_incarnation")
        self.private(os.path.join(root, owner.INCARNATION), b"4" * 64)
        self.private(target, b"changed")
        self.refused(root, good, "stale_operator_intent")
        os.remove(target)
        self.refused(root, good, "stale_operator_intent")
        self.private(target, candidate)
        self.assertEqual((self.journal(root), self.history_bytes(root)), (journal, history))

    def test_ready_refuses_a_stale_journal_and_a_reserved_manifest(self):
        root, target, candidate, good = self.activated("ready-stale-journal")
        # The journal moved on after the BEAM read it.
        record = json.loads(good["expected"])
        moved = self.compact(dict(record, generation=1))
        with open(os.path.join(root, "operator-journal.json"), "w") as f:
            f.write(moved)
        self.refused(root, good, "stale_operator_intent")
        with open(os.path.join(root, "operator-journal.json"), "w") as f:
            f.write(good["expected"])
        # The operator's own journal can never be the manifest ready vouches for.
        journal_path = os.path.join(root, "operator-journal.json")
        self.refused(root, dict(good, checks=[{"path": journal_path, "sha256": owner.digest(candidate)}]),
                     "unsafe_operator_file")

    def test_a_journal_plan_cannot_write_or_advance_a_ready_phase(self):
        root, _, _, good = self.activated("ready-journal-plan")
        journal_plan = {"version": 1, "kind": "journal", "expected": good["expected"],
                        "record": good["record"], "attempt": None, "checks": None, "artifacts": None,
                        "incarnation": None}
        with self.assertRaises(owner.Refusal) as caught:
            owner.execute(root, journal_plan)
        self.assertEqual(str(caught.exception), "stale_operator_intent")
        # Nor can the ready plan's own commit be reused for another phase.
        for phase_record in (good["expected"], self.compact(dict(json.loads(good["expected"]), phase="carrier_pending"))):
            with self.assertRaises(owner.Refusal) as caught:
                owner.commit(root, good["expected"], phase_record, writes="ready")
            self.assertEqual(str(caught.exception), "stale_operator_intent")
        with self.assertRaises(owner.Refusal) as caught:
            owner.commit(root, None, good["record"], writes="ready")
        self.assertEqual(str(caught.exception), "stale_operator_intent")
        self.assertEqual(self.journal(root), good["expected"])

    def test_ready_is_dispatched_only_with_a_record(self):
        root, _, _, good = self.activated("ready-dispatch")
        with self.assertRaises(owner.Refusal) as caught:
            owner.execute(root, dict(good, record=None))
        self.assertEqual(str(caught.exception), "malformed_operator_plan")
        self.assertEqual(self.journal(root), good["expected"])

    def boot_plan(self, target, raw):
        return {"version": 1, "kind": "boot", "expected": None, "record": None, "attempt": None,
                "artifacts": None, "incarnation": None, "checks": [{"path": target, "sha256": owner.digest(raw)}]}

    def test_boot_over_a_ready_record_keeps_it_for_its_own_bytes_only(self):
        root, target, candidate, plan = self.activated("ready-boot")
        with mock.patch.object(owner, "reply"):
            owner.execute(root, plan)
        history = self.history_bytes(root)
        with mock.patch.object(owner, "reply") as reply:
            owner.boot(root, self.boot_plan(target, candidate))
        marker = reply.call_args[0][0]["incarnation"]
        with open(os.path.join(root, owner.INCARNATION), "rb") as f:
            self.assertEqual(f.read(), marker.encode())
        self.assertEqual(self.journal(root), plan["record"])
        self.assertEqual(self.history_bytes(root), history)
        # Any other present bytes contradict the ready record, even ones that
        # match the loaded digest, and the marker is not rewritten.
        other = b'{"version":1,"instances":[]}'
        self.private(target, other)
        with self.assertRaises(owner.Refusal) as caught:
            owner.boot(root, self.boot_plan(target, other))
        self.assertEqual(str(caught.exception), "stale_operator_intent")
        with open(os.path.join(root, owner.INCARNATION), "rb") as f:
            self.assertEqual(f.read(), marker.encode())
        self.assertEqual(self.journal(root), plan["record"])

    def test_stage_may_replace_a_ready_record(self):
        root, target, candidate, plan = self.activated("ready-stage")
        with mock.patch.object(owner, "reply"):
            owner.execute(root, plan)
        record = self.pending(root, 7)
        raw = b"next candidate"
        attempt_dir = os.path.join(root, "attempt-" + owner.digest(record["attempt"].encode()))
        artifact = dict(self.sample()["artifacts"][0], path=os.path.join(attempt_dir, owner.digest(raw)),
                        sha256=owner.digest(raw))
        next_record = self.compact(self.pending(root, 7, artifacts=[artifact]))
        stage = {"version": 1, "kind": "stage", "expected": plan["record"], "record": None,
                 "attempt": record["attempt"], "incarnation": None,
                 "checks": [{"path": target, "sha256": owner.digest(candidate)}],
                 "artifacts": [{"sha256": owner.digest(raw), "bytes": base64.b64encode(raw).decode()}]}
        history = self.history_bytes(root)
        with mock.patch.object(owner, "reply"), mock.patch.object(owner, "line", return_value={"commit": next_record}):
            owner.execute(root, stage)
        self.assertEqual(self.journal(root), next_record)
        self.assertEqual(self.history_bytes(root), history + plan["record"].encode() + b"\n")

    def test_ready_fails_closed_on_an_unsafe_history_file(self):
        root, target, candidate, plan = self.activated("ready-unsafe-history")
        history = os.path.join(root, owner.HISTORY)
        os.remove(history)
        os.symlink(self.private(os.path.join(root, "other"), b""), history)
        self.refused(root, plan, "unsafe_operator_file")
        self.assertEqual(self.journal(root), plan["expected"])


    # Plan 224 PR 3: the owner's catalogued and listed phases and the catalog store.

    def readied(self, name):
        root, target, candidate, plan = self.activated(name)
        with mock.patch.object(owner, "reply"):
            owner.execute(root, plan)
        return root, target, candidate, plan["record"]

    def catalog_plans(self, name, envelope=None):
        """A ready journal, the catalogued plan for it and the listed plan after it."""
        root, target, candidate, ready = self.readied(name)
        envelope = envelope or self.ENVELOPE
        record = json.loads(ready)
        sha = owner.digest(envelope)
        artifact = self.catalog_artifact(root, envelope)
        catalogued = self.compact(dict(record, phase="catalogued", catalog_head=self.CID,
                                       artifacts=record["artifacts"] + [artifact]))
        check = [{"path": target, "sha256": owner.digest(candidate)}]
        first = {"version": 1, "kind": "catalogued", "expected": ready, "record": catalogued,
                 "attempt": record["attempt"], "incarnation": "4" * 64, "checks": check,
                 "artifacts": [{"sha256": sha, "bytes": base64.b64encode(envelope).decode()}]}
        second = {"version": 1, "kind": "listed", "expected": catalogued, "attempt": record["attempt"],
                  "record": self.compact(dict(json.loads(catalogued), phase="listed")), "artifacts": None,
                  "incarnation": "4" * 64, "checks": check}
        return root, target, candidate, first, second

    def store(self, root, name=None, raw=None, mode=0o600):
        path = os.path.join(root, "catalog")
        if not os.path.isdir(path):
            os.mkdir(path, 0o700)
        if name is not None:
            self.private(os.path.join(path, name), raw, mode)
        return path

    def stage_plan(self, root, target, candidate, expected, head, n=7):
        record = self.pending(root, n)
        raw = b"next candidate"
        attempt_dir = os.path.join(root, "attempt-" + owner.digest(record["attempt"].encode()))
        artifact = dict(self.sample()["artifacts"][0], path=os.path.join(attempt_dir, owner.digest(raw)),
                        sha256=owner.digest(raw))
        commit = self.compact(dict(self.pending(root, n, artifacts=[artifact]), catalog_head=head))
        return ({"version": 1, "kind": "stage", "expected": expected, "record": None,
                 "attempt": record["attempt"], "incarnation": None,
                 "checks": [{"path": target, "sha256": owner.digest(candidate)}],
                 "artifacts": [{"sha256": owner.digest(raw), "bytes": base64.b64encode(raw).decode()}]}, commit)

    def run_stage(self, root, plan, commit):
        with mock.patch.object(owner, "reply"), mock.patch.object(owner, "line", return_value={"commit": commit}):
            owner.execute(root, plan)

    def test_catalogued_stores_the_envelope_and_commits(self):
        root, target, candidate, plan, _ = self.catalog_plans("cat-ok")
        history = self.history_bytes(root)
        with mock.patch.object(owner, "reply") as reply:
            owner.execute(root, plan)
        reply.assert_called_once_with({"ok": True})
        final = os.path.join(root, "catalog", owner.digest(self.ENVELOPE) + ".json")
        with open(final, "rb") as f:
            self.assertEqual(f.read(), self.ENVELOPE)
        self.assertEqual(stat.S_IMODE(os.stat(final).st_mode), 0o600)
        self.assertEqual(os.stat(final).st_nlink, 1)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.dirname(final)).st_mode), 0o700)
        self.assertEqual(os.listdir(os.path.dirname(final)), [os.path.basename(final)])
        self.assertEqual(self.journal(root), plan["record"])
        self.assertEqual(self.history_bytes(root), history + plan["expected"].encode() + b"\n")
        with open(target, "rb") as f:
            self.assertEqual(f.read(), candidate)

    def test_catalogued_refusals_leave_store_and_journal_alone(self):
        root, target, candidate, plan, _ = self.catalog_plans("cat-refusals")
        self.refused(root, dict(plan, incarnation="5" * 64), "stale_operator_incarnation", owner.catalogued)
        self.private(os.path.join(root, owner.INCARNATION), b"5" * 64)
        self.refused(root, plan, "stale_operator_incarnation", owner.catalogued)
        self.private(os.path.join(root, owner.INCARNATION), b"4" * 64)
        self.private(target, b"changed")
        self.refused(root, plan, "stale_operator_intent", owner.catalogued)
        self.private(target, candidate)
        journal_path = os.path.join(root, "operator-journal.json")
        self.refused(root, dict(plan, checks=[{"path": journal_path, "sha256": owner.digest(candidate)}]),
                     "unsafe_operator_file", owner.catalogued)
        self.refused(root, dict(plan, checks=[{"path": os.path.join(root, "catalog", "x"),
                                               "sha256": owner.digest(candidate)}]),
                     "unsafe_operator_file", owner.catalogued)
        self.assertFalse(os.path.exists(os.path.join(root, "catalog")))
        self.assertEqual(self.journal(root), plan["expected"])

    def test_catalogued_refuses_a_plan_supplied_store_path(self):
        root, _, _, plan, _ = self.catalog_plans("cat-path")
        record = json.loads(plan["record"])
        for path in ("/tmp/{}.json", os.path.join("{}".format(root), "attempt", "{}.json"),
                     os.path.join(root, "catalog", "../{}.json")):
            record["artifacts"][-1]["path"] = path.format(owner.digest(self.ENVELOPE))
            self.refused(root, dict(plan, record=self.compact(record)), "malformed_operator_plan",
                         owner.catalogued)
        self.assertFalse(os.path.exists(os.path.join(root, "catalog")))
        # commit() applies the same rule to any record that reaches it.
        with self.assertRaises(owner.Refusal) as caught:
            owner.commit(root, plan["expected"], self.compact(record), writes="catalogued")
        self.assertEqual(str(caught.exception), "malformed_operator_plan")

    def test_catalogued_over_an_existing_final_with_other_bytes_conflicts(self):
        root, _, _, plan, _ = self.catalog_plans("cat-conflict")
        self.store(root, owner.digest(self.ENVELOPE) + ".json", b"different")
        self.refused(root, plan, "immutable_artifact_conflict", owner.catalogued)
        self.assertEqual(self.journal(root), plan["expected"])
        with open(os.path.join(root, "catalog", owner.digest(self.ENVELOPE) + ".json"), "rb") as f:
            self.assertEqual(f.read(), b"different")
        self.assertEqual([n for n in os.listdir(os.path.join(root, "catalog")) if n.startswith(".tmp.")], [])

    def test_catalogued_over_an_existing_final_with_equal_bytes_is_a_noop_commit(self):
        # Crash window (i): the envelope was linked, the journal never moved.
        root, _, _, plan, _ = self.catalog_plans("cat-crash")
        final = owner.digest(self.ENVELOPE) + ".json"
        self.store(root, final, self.ENVELOPE)
        before = os.stat(os.path.join(root, "catalog", final)).st_ino
        with mock.patch.object(owner, "reply"):
            owner.execute(root, plan)
        self.assertEqual(os.stat(os.path.join(root, "catalog", final)).st_ino, before)
        self.assertEqual(self.journal(root), plan["record"])

    def test_catalogued_removes_leftover_temps_and_refuses_unknown_names(self):
        root, _, _, plan, _ = self.catalog_plans("cat-temp")
        leftover = ".tmp." + "ab" * 16
        self.store(root, leftover, b"torn")
        with mock.patch.object(owner, "reply"):
            owner.execute(root, plan)
        self.assertEqual(os.listdir(os.path.join(root, "catalog")), [owner.digest(self.ENVELOPE) + ".json"])
        root, _, _, plan, _ = self.catalog_plans("cat-unknown")
        for name in ("notes.txt", ".tmp.short", "A" * 64 + ".json", ".tmp." + "AB" * 16):
            path = self.store(root, name, b"x")
            self.refused(root, plan, "catalog_store_corrupt", owner.catalogued)
            os.remove(os.path.join(path, name))
        self.assertEqual(self.journal(root), plan["expected"])

    def test_catalogued_refuses_an_unsafe_store_directory(self):
        root, _, _, plan, _ = self.catalog_plans("cat-unsafe-dir")
        path = self.store(root)
        os.chmod(path, 0o750)
        self.refused(root, plan, "unsafe_operator_directory", owner.catalogued)
        os.chmod(path, 0o700)
        os.rmdir(path)
        other = os.path.join(root, "elsewhere")
        os.mkdir(other, 0o700)
        os.symlink(other, path)
        with self.assertRaises((owner.Refusal, OSError)):
            owner.catalogued(root, plan)
        self.assertEqual(os.listdir(other), [])
        self.assertEqual(self.journal(root), plan["expected"])

    def test_journal_plan_cannot_write_catalogued_or_listed(self):
        root, _, _, first, second = self.catalog_plans("cat-journal")
        for expected, record in [(first["expected"], first["record"]),
                                 (second["expected"], second["record"])]:
            plan = {"version": 1, "kind": "journal", "expected": expected, "record": record, "attempt": None,
                    "checks": None, "artifacts": None, "incarnation": None}
            with self.assertRaises(owner.Refusal) as caught:
                owner.execute(root, plan)
            self.assertEqual(str(caught.exception), "stale_operator_intent")
        for writes in (None, "ready", "listed", "activated"):
            with self.assertRaises(owner.Refusal) as caught:
                owner.commit(root, first["expected"], first["record"], writes=writes)
            self.assertEqual(str(caught.exception), "stale_operator_intent")
        self.assertEqual(self.journal(root), first["expected"])
        self.assertFalse(os.path.exists(os.path.join(root, "catalog")))

    def test_commit_phase_must_match_what_it_writes(self):
        root, _, _, first, _ = self.catalog_plans("cat-writes")
        with self.assertRaises(owner.Refusal) as caught:
            owner.commit(root, None, first["record"], writes="catalogued")
        self.assertEqual(str(caught.exception), "stale_operator_intent")

    def test_listed_after_catalogued(self):
        root, target, candidate, first, second = self.catalog_plans("cat-listed")
        with mock.patch.object(owner, "reply"):
            owner.execute(root, first)
        history = self.history_bytes(root)
        with mock.patch.object(owner, "reply") as reply:
            owner.execute(root, second)
        reply.assert_called_once_with({"ok": True})
        self.assertEqual(self.journal(root), second["record"])
        self.assertEqual(self.history_bytes(root), history + second["expected"].encode() + b"\n")
        self.assertEqual(json.loads(self.journal(root))["catalog_head"], self.CID)

    def test_listed_refusals_leave_the_journal_alone(self):
        root, target, candidate, first, second = self.catalog_plans("cat-listed-refusals")
        # Listing before cataloguing is not a phase move the owner allows.
        with self.assertRaises(owner.Refusal):
            owner.listed(root, second)
        with mock.patch.object(owner, "reply"):
            owner.execute(root, first)
        final = os.path.join(root, "catalog", owner.digest(self.ENVELOPE) + ".json")
        self.refused(root, dict(second, incarnation="5" * 64), "stale_operator_incarnation", owner.listed)
        self.private(target, b"changed")
        self.refused(root, second, "stale_operator_intent", owner.listed)
        self.private(target, candidate)
        os.chmod(final, 0o644)
        self.refused(root, second, "unsafe_operator_file", owner.listed)
        os.chmod(final, 0o600)
        self.private(final, b"tampered")
        self.refused(root, second, "immutable_artifact_conflict", owner.listed)
        os.remove(final)
        self.refused(root, second, "immutable_artifact_conflict", owner.listed)
        self.assertEqual(self.journal(root), second["expected"])

    def test_listed_commit_phase_and_head_are_checked(self):
        root, _, _, first, second = self.catalog_plans("cat-listed-commit")
        with mock.patch.object(owner, "reply"):
            owner.execute(root, first)
        with self.assertRaises(owner.Refusal) as caught:
            owner.commit(root, second["expected"], second["record"], writes="ready")
        self.assertEqual(str(caught.exception), "stale_operator_intent")
        # A stage after listing keeps the committed head, with no pending envelope.
        plan, commit = self.stage_plan(root, second["checks"][0]["path"], self.ENVELOPE, second["expected"], None)
        with self.assertRaises(owner.Refusal) as caught:
            self.run_stage(root, dict(plan, checks=second["checks"]), commit)
        self.assertEqual(str(caught.exception), "stale_catalog_head")

    def test_stage_requires_the_committed_head_and_no_pending_envelope(self):
        root, target, candidate, first, second = self.catalog_plans("cat-stage")
        with mock.patch.object(owner, "reply"):
            owner.execute(root, first)
            owner.execute(root, second)
        listed = second["record"]
        journal, history = self.journal(root), self.history_bytes(root)
        other = base64.urlsafe_b64encode(bytes([8]) * 32).decode().rstrip("=")
        for head in (None, other):
            plan, commit = self.stage_plan(root, target, candidate, listed, head)
            with self.assertRaises(owner.Refusal, msg=repr(head)) as caught:
                self.run_stage(root, plan, commit)
            self.assertEqual(str(caught.exception), "stale_catalog_head")
        # A pending envelope: a final whose digest no record names.
        pending = self.store(root, owner.digest(b"pending") + ".json", b"pending")
        plan, commit = self.stage_plan(root, target, candidate, listed, self.CID)
        with self.assertRaises(owner.Refusal) as caught:
            self.run_stage(root, plan, commit)
        self.assertEqual(str(caught.exception), "stale_catalog_head")
        self.assertEqual((self.journal(root), self.history_bytes(root)), (journal, history))
        os.remove(os.path.join(pending, owner.digest(b"pending") + ".json"))
        # A leftover temp is not a pending envelope.
        self.store(root, ".tmp." + "cd" * 16, b"torn")
        self.run_stage(root, plan, commit)
        self.assertEqual(self.journal(root), commit)
        self.assertEqual(json.loads(self.journal(root))["catalog_head"], self.CID)
        # The head now lives only in history, and still binds the next stage.
        plan, again = self.stage_plan(root, target, candidate, commit, None, n=8)
        with self.assertRaises(owner.Refusal) as caught:
            self.run_stage(root, plan, again)
        self.assertEqual(str(caught.exception), "stale_catalog_head")
        plan, again = self.stage_plan(root, target, candidate, commit, self.CID, n=8)
        self.run_stage(root, plan, again)
        self.assertEqual(self.journal(root), again)

    def test_stage_with_a_pending_envelope_and_no_receipt_refuses_a_null_head(self):
        root, target, candidate, ready = self.readied("cat-pending-ready")
        self.store(root, owner.digest(b"pending") + ".json", b"pending")
        plan, commit = self.stage_plan(root, target, candidate, ready, None)
        with self.assertRaises(owner.Refusal) as caught:
            self.run_stage(root, plan, commit)
        self.assertEqual(str(caught.exception), "stale_catalog_head")
        self.assertEqual(self.journal(root), ready)
        # An unknown name is corruption, not a pending envelope.
        os.remove(os.path.join(root, "catalog", owner.digest(b"pending") + ".json"))
        self.store(root, "junk", b"x")
        with self.assertRaises(owner.Refusal) as caught:
            self.run_stage(root, plan, commit)
        self.assertEqual(str(caught.exception), "catalog_store_corrupt")

    def test_a_deployment_path_under_the_catalog_store_collides(self):
        root = self.workdir("collision-catalog")
        store = os.path.join(root, "catalog")
        for path in (store, os.path.join(store, "x.json"), os.path.join(store, "a", "b")):
            with self.assertRaises(owner.Refusal, msg=path) as caught:
                owner.apart(root, path)
            self.assertEqual(str(caught.exception), "operator_path_collision")
            manifest = json.dumps({"version": 1, "instances": [
                {"identity_file": "/srv/a.identity", "log_file": path}]}).encode()
            with self.assertRaises(owner.Refusal, msg=path) as caught:
                owner.absolute_paths(manifest, root)
            self.assertEqual(str(caught.exception), "operator_path_collision")
        self.assertIn(store, owner.reserved_files(root))
        self.assertNotIn(store + "x", owner.reserved_files(root))
        # A hard link to a stored envelope is the same file under another name.
        name = owner.digest(b"e") + ".json"
        self.store(root, name, b"e")
        alias = os.path.join(root, "alias.log")
        os.link(os.path.join(store, name), alias)
        with self.assertRaises(owner.Refusal) as caught:
            owner.apart(root, alias)
        self.assertEqual(str(caught.exception), "operator_path_collision")
        owner.apart(root, os.path.join(root, "catalogue", "x"))

    def test_boot_over_catalogued_and_listed_keeps_them_for_their_own_bytes_only(self):
        root, target, candidate, first, second = self.catalog_plans("cat-boot")
        other = b'{"version":1,"instances":[]}'
        for plan in (first, second):
            with mock.patch.object(owner, "reply"):
                owner.execute(root, plan)
            history = self.history_bytes(root)
            with mock.patch.object(owner, "reply") as reply:
                owner.boot(root, self.boot_plan(target, candidate))
            marker = reply.call_args[0][0]["incarnation"]
            self.assertEqual(self.journal(root), plan["record"])
            self.assertEqual(self.history_bytes(root), history)
            self.private(target, other)
            with self.assertRaises(owner.Refusal) as caught:
                owner.boot(root, self.boot_plan(target, other))
            self.assertEqual(str(caught.exception), "stale_operator_intent")
            with open(os.path.join(root, owner.INCARNATION), "rb") as f:
                self.assertEqual(f.read(), marker.encode())
            self.private(target, candidate)
            self.private(os.path.join(root, owner.INCARNATION), b"4" * 64)


if __name__ == "__main__":
    unittest.main()
