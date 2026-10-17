#!/usr/bin/env python3
"""Private Linux operator mutation owner. Requires Python3.
The same process owns flock and every write/fsync. Killing it stops mutation;
there is no separately running BEAM writer after lock loss. Its one activation
step replaces the active manifest file with a staged candidate; it never starts,
stops or restarts a service, and never signs anything. A controlled carrier boot
runs its own plan under the same lock: it completes a pending activation whose
candidate is already active, refuses bytes the journal contradicts, and writes
the incarnation marker that binds any later activation to that boot.
"""
import base64
import fcntl
import hashlib
import json
import os
import re
import stat
import sys

MAX_LINE = 64 * 1024 * 1024
MAX_FILE = 32 * 1024 * 1024
MAX_JOURNAL = 1024 * 1024
SAFE = 9007199254740991
PHASES = ("carrier_pending", "activated")
INCARNATION = "operator-incarnation"


class Refusal(Exception):
    pass


def refuse(reason):
    raise Refusal(reason)


def closed(value, keys):
    return type(value) is dict and set(value) == set(keys)


def pairs(values):
    result = {}
    for key, value in values:
        if key in result:
            refuse("malformed_operator_plan")
        result[key] = value
    return result


def decode(raw):
    try:
        return json.loads(raw, object_pairs_hook=pairs,
                          parse_constant=lambda _: refuse("malformed_operator_plan"))
    except (ValueError, UnicodeError, RecursionError):
        refuse("malformed_operator_plan")


def line():
    raw = sys.stdin.buffer.readline(MAX_LINE + 1)
    if not raw.endswith(b"\n") or len(raw) > MAX_LINE:
        refuse("malformed_operator_plan")
    return decode(raw)


def reply(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def hex_id(value):
    return type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def op_id(value):
    if type(value) is not str or re.fullmatch(r"[A-Za-z0-9_-]{43}", value) is None:
        return False
    return base64.urlsafe_b64encode(base64.urlsafe_b64decode(value + "=")).decode().rstrip("=") == value


def binary(value):
    if type(value) is not str:
        refuse("malformed_operator_plan")
    try:
        raw = base64.b64decode(value, validate=True)
    except ValueError:
        refuse("malformed_operator_plan")
    if not raw or len(raw) > MAX_FILE or base64.b64encode(raw).decode() != value:
        refuse("malformed_operator_plan")
    return raw


def directory(path):
    if type(path) is not str or not os.path.isabs(path) or os.path.normpath(path) != path:
        refuse("unsafe_operator_directory")
    current = path
    while True:
        st = os.lstat(current)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid not in (0, os.geteuid()) or st.st_mode & 0o022:
            refuse("unsafe_operator_directory")
        parent = os.path.dirname(current)
        if parent == current:
            return
        current = parent


def file_bytes(path, bound=MAX_FILE, missing=False, private=False, allow_root=False):
    directory(os.path.dirname(path))
    try:
        # O_NONBLOCK keeps a non-regular path (a FIFO in particular) from
        # blocking this open indefinitely; it has no effect on a regular
        # file. The S_ISREG check below still runs before any read.
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        if missing:
            return None
        raise
    owners = (0, os.geteuid()) if allow_root else (os.geteuid(),)
    with os.fdopen(fd, "rb") as stream:
        st = os.fstat(stream.fileno())
        if (not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid not in owners
                or st.st_mode & (0o077 if private else 0o022) or st.st_size > bound):
            refuse("unsafe_operator_file")
        raw = stream.read(bound + 1)
        if len(raw) > bound:
            refuse("unsafe_operator_file")
        return raw


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def artifact_record(a):
    if not closed(a, ["kind", "op_id", "path", "replica", "sha256", "review"]):
        return False
    if type(a["path"]) is not str or not os.path.isabs(a["path"]) or not hex_id(a["sha256"]):
        return False
    if a["kind"] == "manifest":
        return a["op_id"] is None and a["replica"] is None and a["review"] is None
    if a["kind"] not in ("log", "reference") or not op_id(a["op_id"]) or type(a["replica"]) is not str:
        return False
    if a["kind"] == "reference":
        return a["review"] is None
    r = a["review"]
    return (closed(r, ["creation", "profile_genesis", "profile_id", "grants"])
            and all(op_id(r[k]) for k in ("creation", "profile_genesis", "profile_id"))
            and type(r["grants"]) is list and len(r["grants"]) <= 128
            and all(closed(g, ["recipient", "delegation", "introduction"])
                    and type(g["recipient"]) is str and op_id(g["delegation"]) and op_id(g["introduction"])
                    for g in r["grants"]))


def service_record(s):
    if not closed(s, ["identity_file", "realm", "pub", "sha256"]):
        return False
    path = s["identity_file"]
    if type(path) is not str or not os.path.isabs(path) or os.path.normpath(path) != path:
        return False
    if type(s["realm"]) is not str or not s["realm"] or not hex_id(s["sha256"]):
        return False
    if type(s["pub"]) is not str:
        return False
    try:
        pub = base64.b64decode(s["pub"], validate=True)
    except ValueError:
        return False
    return len(pub) == 32 and base64.b64encode(pub).decode() == s["pub"]


def current_service(s):
    # The admitted carrier identity file must still hold the exact bytes
    # staging reviewed; a rotation after review is stale intent, never
    # carried into a pending record. Identity files are private to this
    # service user, exactly as the carrier manifest requires. The full call is
    # wrapped because a missing ancestor raises from directory()'s own lstat.
    try:
        raw = file_bytes(s["identity_file"], private=True)
    except FileNotFoundError:
        refuse("stale_operator_intent")
    except OSError:
        # O_NOFOLLOW on a symlinked identity (ELOOP) or any other open
        # failure is a closed refusal, not an opaque persistence failure.
        refuse("unsafe_operator_file")
    if digest(raw) != s["sha256"]:
        refuse("stale_operator_intent")


def record(raw):
    if type(raw) is not str or len(raw.encode()) > MAX_JOURNAL:
        refuse("corrupt_operator_journal")
    r = decode(raw)
    if (not closed(r, ["version", "phase", "attempt", "generation", "catalog_head", "manifest_digest", "artifacts",
                       "service"])
            or type(r["version"]) is not int or r["version"] != 1 or r["phase"] not in PHASES
            or not op_id(r["attempt"]) or type(r["generation"]) is not int or not 0 <= r["generation"] < SAFE
            or not (r["catalog_head"] is None or op_id(r["catalog_head"])) or not hex_id(r["manifest_digest"])
            or type(r["artifacts"]) is not list or not 1 <= len(r["artifacts"]) <= 128
            or not all(artifact_record(a) for a in r["artifacts"])
            or len({a["path"] for a in r["artifacts"]}) != len(r["artifacts"])
            or not service_record(r["service"])):
        refuse("corrupt_operator_journal")
    return r


def expected(root, raw):
    actual = file_bytes(os.path.join(root, "operator-journal.json"), MAX_JOURNAL, missing=True, private=True)
    if actual is not None:
        record(actual.decode("utf-8"))
    if raw is not None:
        record(raw)
    if actual != (None if raw is None else raw.encode()):
        refuse("stale_operator_intent")


def snapshots(checks):
    if type(checks) is not list or not 1 <= len(checks) <= 129:
        refuse("malformed_operator_plan")
    for check in checks:
        if not closed(check, ["path", "sha256"]) or not hex_id(check["sha256"]):
            refuse("malformed_operator_plan")
        if type(check["path"]) is not str or not os.path.isabs(check["path"]):
            refuse("malformed_operator_plan")
        # These are read-only snapshot inputs (the active manifest and its
        # referenced logs), so a root-provisioned deployment file is
        # accepted alongside one owned by this service user. The full call
        # is wrapped, not just the leaf open, because a missing ancestor
        # directory raises FileNotFoundError from directory()'s own lstat.
        try:
            raw = file_bytes(check["path"], allow_root=True)
        except FileNotFoundError:
            refuse("stale_operator_intent")
        if digest(raw) != check["sha256"]:
            refuse("stale_operator_intent")


def retain(path, raw):
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        if file_bytes(path, private=True) != raw:
            refuse("immutable_artifact_conflict")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    else:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
    sync_dir(os.path.dirname(path))
    if file_bytes(path, private=True) != raw:
        refuse("immutable_artifact_conflict")


def commit(root, old, raw, activation=False):
    next_record = record(raw)
    # Only activate() may write an activated record, after its own checks;
    # an ordinary plan can neither create one nor move an attempt's phase.
    if not activation and next_record["phase"] != "carrier_pending":
        refuse("stale_operator_intent")
    if old is not None and not activation:
        old_record = record(old)
        if old_record["attempt"] == next_record["attempt"] and old_record != next_record:
            refuse("stale_operator_intent")
    expected(root, old)
    current_service(next_record["service"])
    # Exclusive temp is deliberately preserved on failure; never guess that an orphan is disposable.
    temporary = os.path.join(root, "operator-journal.json.tmp." + os.urandom(16).hex())
    retain(temporary, raw.encode())
    expected(root, old)
    current_service(next_record["service"])
    os.replace(temporary, os.path.join(root, "operator-journal.json"))
    sync_dir(root)
    if file_bytes(os.path.join(root, "operator-journal.json"), MAX_JOURNAL, private=True) != raw.encode():
        refuse("corrupt_operator_journal")


def activate(root, plan):
    """Replace the active manifest with the staged candidate, then record it.
    checks[0] is the active manifest; the rest are the sealed route logs, which
    must still hold the exact bytes the seal captured.
    The manifest replace is the activation point. A retry after a replace whose
    journal commit was lost finds the candidate bytes already active and only
    commits the journal; any other active content is stale intent."""
    checks = plan["checks"]
    if (plan["artifacts"] is not None or type(plan["expected"]) is not str
            or not op_id(plan["attempt"]) or not hex_id(plan["incarnation"])
            or type(checks) is not list or not 2 <= len(checks) <= 129
            or not all(closed(c, ["path", "sha256"]) and hex_id(c["sha256"])
                       and type(c["path"]) is str and os.path.isabs(c["path"])
                       and os.path.normpath(c["path"]) == c["path"] for c in checks)
            or len({c["path"] for c in checks}) != len(checks)):
        refuse("malformed_operator_plan")
    old = record(plan["expected"])
    if (old["phase"] != "carrier_pending" or old["attempt"] != plan["attempt"]
            or record(plan["record"]) != dict(old, phase="activated")
            or checks[0]["sha256"] != old["manifest_digest"]):
        refuse("stale_operator_intent")
    # The boot that sealed this attempt must still be the latest controlled
    # boot. A restart that completed before this lock was taken wrote a new
    # marker, so its old bytes are never contradicted by an activated record;
    # one that starts while this lock is held refuses operator_busy.
    if file_bytes(os.path.join(root, INCARNATION), 64, missing=True, private=True) != plan["incarnation"].encode():
        refuse("stale_operator_incarnation")
    manifests = [a for a in old["artifacts"] if a["kind"] == "manifest"]
    if len(manifests) != 1:
        refuse("corrupt_operator_journal")
    candidate = staged(manifests[0])
    target = checks[0]["path"]
    absolute_paths(candidate)
    if target in reserved(root, old):
        refuse("unsafe_operator_file")
    # Every staged artifact still holds its reviewed bytes, on the first
    # attempt and on a retry alike.
    for a in old["artifacts"]:
        staged(a)
    expected(root, plan["expected"])
    current_service(old["service"])
    snapshots(checks[1:])
    present = digest(active(target))
    if present == old["manifest_digest"]:
        # Beside the target, so the replace never crosses a filesystem. An
        # exclusive temp is preserved on failure, exactly like the journal's.
        temporary = os.path.join(os.path.dirname(target),
                                 "." + os.path.basename(target) + ".activate." + os.urandom(16).hex())
        retain(temporary, candidate)
        expected(root, plan["expected"])
        current_service(old["service"])
        snapshots(checks[1:])
        if digest(active(target)) != old["manifest_digest"]:
            refuse("stale_operator_intent")
        os.replace(temporary, target)
        sync_dir(os.path.dirname(target))
        if active(target) != candidate:
            refuse("immutable_artifact_conflict")
    elif present == manifests[0]["sha256"]:
        # A lost commit may also have lost the directory sync after its
        # replace; make the active candidate durable before recording it.
        durable(target)
    else:
        refuse("stale_operator_intent")
    commit(root, plan["expected"], plan["record"], activation=True)
    reply({"ok": True})


def one_check(checks):
    return (type(checks) is list and len(checks) == 1 and closed(checks[0], ["path", "sha256"])
            and hex_id(checks[0]["sha256"]) and type(checks[0]["path"]) is str
            and os.path.isabs(checks[0]["path"]) and os.path.normpath(checks[0]["path"]) == checks[0]["path"])


def boot(root, plan):
    """Run for one controlled carrier boot, after it loaded its manifest and
    before any route starts. Holding the operator lock here is what refuses a
    boot while an activation is in flight (operator_busy). Under the lock the
    loaded bytes must still be the active bytes, and the journal is reconciled
    with them: a pending record whose staged candidate is already active (an
    owner died after the replace, before the commit) is recorded activated
    after the same staged-artifact checks activate() makes; an activated record
    over its own pre-activation bytes refuses. Any other pending record is left
    for activation to judge. Finally a fresh incarnation marker is written."""
    if any(plan[k] is not None for k in ("expected", "record", "attempt", "artifacts", "incarnation")):
        refuse("malformed_operator_plan")
    if not one_check(plan["checks"]):
        refuse("malformed_operator_plan")
    target, loaded = plan["checks"][0]["path"], plan["checks"][0]["sha256"]
    path = os.path.join(root, "operator-journal.json")
    raw = file_bytes(path, MAX_JOURNAL, missing=True, private=True)
    if raw is not None:
        raw = raw.decode("utf-8")
        old = record(raw)
        try:
            present = digest(file_bytes(target, allow_root=True))
        except FileNotFoundError:
            refuse("stale_operator_intent")
        except OSError:
            refuse("unsafe_operator_file")
        if present != loaded:
            refuse("stale_operator_intent")
        manifests = [a for a in old["artifacts"] if a["kind"] == "manifest"]
        if len(manifests) != 1:
            refuse("corrupt_operator_journal")
        candidate = manifests[0]["sha256"]
        if old["phase"] == "carrier_pending" and present == candidate != old["manifest_digest"]:
            for a in old["artifacts"]:
                staged(a)
            durable(target)
            # The canonical record differs from its activated form in this one
            # structural member; a quote inside any string value is escaped,
            # so the pattern cannot match inside one.
            pending = '"phase":"carrier_pending"'
            if raw.count(pending) != 1:
                refuse("corrupt_operator_journal")
            activated = raw.replace(pending, '"phase":"activated"')
            if record(activated) != dict(old, phase="activated"):
                refuse("corrupt_operator_journal")
            commit(root, raw, activated, activation=True)
        elif old["phase"] == "activated" and present == old["manifest_digest"] != candidate:
            refuse("stale_operator_intent")
    marker = os.urandom(32).hex()
    temporary = os.path.join(root, INCARNATION + ".tmp." + os.urandom(16).hex())
    try:
        retain(temporary, marker.encode())
        os.replace(temporary, os.path.join(root, INCARNATION))
        sync_dir(root)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
    if file_bytes(os.path.join(root, INCARNATION), 64, private=True) != marker.encode():
        refuse("operator_persistence_failed")
    reply({"incarnation": marker})


def absolute_paths(raw):
    """The candidate is installed beside the active manifest, not in its
    attempt directory, so a relative path in it would name a different,
    unreviewed file after activation."""
    try:
        manifest = decode(raw.decode("utf-8"))
    except (Refusal, UnicodeError):
        refuse("unsafe_candidate_manifest")
    instances = manifest.get("instances") if type(manifest) is dict else None
    if type(instances) is not list:
        refuse("unsafe_candidate_manifest")
    for instance in instances:
        for key in ("identity_file", "log_file"):
            path = instance.get(key) if type(instance) is dict else None
            if type(path) is not str or not os.path.isabs(path) or os.path.normpath(path) != path:
                refuse("unsafe_candidate_manifest")


def reserved(root, r):
    """Paths activation must never replace: the lock it holds, the journal it
    commits, the boot incarnation marker it checks and the staged artifacts it
    rechecks."""
    return ({os.path.join(root, "operator.lock"), os.path.join(root, "operator-journal.json"),
             os.path.join(root, INCARNATION)}
            | {a["path"] for a in r["artifacts"]})


def durable(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        refuse("unsafe_operator_file")
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            refuse("unsafe_operator_file")
        os.fsync(fd)
    finally:
        os.close(fd)
    sync_dir(os.path.dirname(path))


def staged(artifact):
    try:
        raw = file_bytes(artifact["path"], private=True)
    except FileNotFoundError:
        refuse("immutable_artifact_conflict")
    if digest(raw) != artifact["sha256"]:
        refuse("immutable_artifact_conflict")
    return raw


def active(path):
    # The replaced manifest must belong to this service user under a secure
    # directory chain; a root-provisioned deployment file is refused, not
    # rewritten.
    try:
        raw = file_bytes(path)
    except FileNotFoundError:
        refuse("stale_operator_intent")
    except OSError:
        # A symlinked target (ELOOP) or any other open failure is a closed
        # refusal, exactly as for the identity file.
        refuse("unsafe_operator_file")
    if not os.access(os.path.dirname(path), os.W_OK | os.X_OK):
        refuse("unsafe_operator_directory")
    return raw


def execute(root, plan):
    if not closed(plan, ["version", "kind", "expected", "record", "attempt", "checks", "artifacts",
                         "incarnation"]):
        refuse("malformed_operator_plan")
    if type(plan["version"]) is not int or plan["version"] != 1:
        refuse("malformed_operator_plan")
    if plan["kind"] == "boot":
        boot(root, plan)
        return
    if plan["kind"] == "activate":
        if plan["record"] is None:
            refuse("malformed_operator_plan")
        activate(root, plan)
        return
    if plan["incarnation"] is not None:
        refuse("malformed_operator_plan")
    if plan["kind"] == "journal":
        if any(plan[k] is not None for k in ("attempt", "checks", "artifacts")):
            refuse("malformed_operator_plan")
        commit(root, plan["expected"], plan["record"])
        reply({"ok": True})
        return
    if plan["kind"] != "stage" or plan["record"] is not None or not op_id(plan["attempt"]):
        refuse("malformed_operator_plan")
    artifacts = plan["artifacts"]
    if type(artifacts) is not list or not 1 <= len(artifacts) <= 128:
        refuse("malformed_operator_plan")
    material = []
    for a in artifacts:
        if not closed(a, ["sha256", "bytes"]) or not hex_id(a["sha256"]):
            refuse("malformed_operator_plan")
        raw = binary(a["bytes"])
        if digest(raw) != a["sha256"]:
            refuse("malformed_operator_plan")
        material.append((a["sha256"], raw))
    if len({d for d, _ in material}) != len(material) or sum(len(b) for _, b in material) > 32 * 1024 * 1024:
        refuse("malformed_operator_plan")
    expected(root, plan["expected"])
    snapshots(plan["checks"])
    attempt_dir = os.path.join(root, "attempt-" + digest(plan["attempt"].encode()))
    try:
        os.mkdir(attempt_dir, 0o700)
        sync_dir(root)
    except FileExistsError:
        directory(attempt_dir)
    for name, raw in material:
        retain(os.path.join(attempt_dir, name), raw)
    if sorted(os.listdir(attempt_dir)) != sorted(d for d, _ in material):
        refuse("ambiguous_staging_inventory")
    reply({"staged": True})
    final = line()
    if not closed(final, ["commit"]):
        refuse("malformed_operator_plan")
    next_record = record(final["commit"])
    required = {(os.path.join(attempt_dir, d), d) for d, _ in material}
    if (next_record["attempt"] != plan["attempt"] or
            {(a["path"], a["sha256"]) for a in next_record["artifacts"]} != required):
        refuse("malformed_operator_plan")
    expected(root, plan["expected"])
    snapshots(plan["checks"])
    for name, raw in material:
        if file_bytes(os.path.join(attempt_dir, name), private=True) != raw:
            refuse("immutable_artifact_conflict")
    commit(root, plan["expected"], final["commit"])
    reply({"ok": True})


def main():
    if sys.platform != "linux":
        refuse("unsupported_operator_platform")
    if len(sys.argv) != 2:
        refuse("malformed_operator_plan")
    root = sys.argv[1]
    directory(root)
    plan = line()
    fd = os.open(os.path.join(root, "operator.lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_nlink != 1 or st.st_mode & 0o077:
            refuse("unsafe_operator_lock")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            refuse("operator_busy")
        execute(root, plan)
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        main()
    except Refusal as error:
        reply({"error": str(error)})
        sys.exit(1)
    except (OSError, ValueError, TypeError, KeyError, UnicodeError):
        reply({"error": "operator_persistence_failed"})
        sys.exit(1)
