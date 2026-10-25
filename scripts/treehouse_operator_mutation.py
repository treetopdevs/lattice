#!/usr/bin/env python3
"""Private Linux operator mutation owner. Requires Python3.
The same process owns flock and every write/fsync. Killing it stops mutation;
there is no separately running BEAM writer after lock loss. Its one activation
step replaces the active manifest file with a staged candidate; it never starts,
stops or restarts a service, and never signs anything. Its ready step records,
after the BEAM proved its local facts, that the activated candidate is still the
active manifest under the latest boot's incarnation. A controlled carrier boot
runs its own plan under the same lock: it completes a pending activation whose
candidate is already active, refuses bytes the journal contradicts, and writes
the incarnation marker that binds any later activation to that boot.
Its catalogued step stores one signed catalog envelope under catalog/ (never
deleted) and its listed step records the BEAM's receipt; neither signs or serves.
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
PHASES = ("carrier_pending", "activated", "ready", "catalogued", "listed")
MAX_CATALOG = 131072
MAX_HISTORY = 64 * 1024 * 1024
CATALOG = "catalog"
INCARNATION = "operator-incarnation"
HISTORY = "operator-journal-history.jsonl"


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
    if a["kind"] not in ("log", "reference", "catalog") or not op_id(a["op_id"]) or type(a["replica"]) is not str:
        return False
    if a["kind"] == "catalog":
        return a["review"] is None and a["replica"] != ""
    if a["kind"] == "reference":
        return a["review"] is None or a["review"] == {"mode": "initial_existing"}
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
            or type(r["artifacts"]) is not list or not 1 <= len(r["artifacts"]) <= 129
            or not all(artifact_record(a) for a in r["artifacts"])
            or len({a["path"] for a in r["artifacts"]}) != len(r["artifacts"])
            or not service_record(r["service"])):
        refuse("corrupt_operator_journal")
    # A catalog artifact exists exactly in the catalogued and listed phases, and
    # then the record's head is that artifact's catalog id.
    catalogs = [a for a in r["artifacts"] if a["kind"] == "catalog"]
    # 128 staged artifacts plus the one catalog receipt.
    if len(r["artifacts"]) - len(catalogs) > 128:
        refuse("corrupt_operator_journal")
    if r["phase"] in ("catalogued", "listed"):
        if len(catalogs) != 1 or r["catalog_head"] != catalogs[0]["op_id"]:
            refuse("corrupt_operator_journal")
    elif catalogs:
        refuse("corrupt_operator_journal")
    return r


def canonical(r):
    """The exact bytes the BEAM's Journal.encode/1 writes for a decoded
    record: fixed key order, compact, raw UTF-8."""
    def pick(d, keys):
        return {k: d[k] for k in keys}
    artifacts = []
    for a in r["artifacts"]:
        a = pick(a, ["kind", "op_id", "path", "replica", "review", "sha256"])
        if a["kind"] == "reference" and a["review"] is not None:
            a["review"] = pick(a["review"], ["mode"])
        elif a["review"] is not None:
            review = pick(a["review"], ["creation", "grants", "profile_genesis", "profile_id"])
            review["grants"] = [pick(g, ["delegation", "introduction", "recipient"]) for g in review["grants"]]
            a["review"] = review
        artifacts.append(a)
    out = pick(r, ["version", "phase", "attempt", "generation", "catalog_head", "manifest_digest", "artifacts",
                   "service"])
    out["artifacts"] = artifacts
    out["service"] = pick(r["service"], ["identity_file", "pub", "realm", "sha256"])
    text = json.dumps(out, separators=(",", ":"), ensure_ascii=False)
    # Jason writes control escapes with uppercase hex; an escaped backslash is
    # matched first so a literal "\u" in a string is never rewritten.
    return re.sub(r"(\\\\)|\\u([0-9a-f]{4})", lambda m: m.group(1) or "\\u" + m.group(2).upper(), text)


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


def history_file(root):
    """Open the journal history, creating it, and refuse anything but this
    user's private regular single-link file. Activation and boot reconcile
    call it before their irreversible step, so an unsafe history file never
    refuses after the manifest is already replaced."""
    try:
        # O_NONBLOCK keeps a FIFO from blocking the open; it has no effect on
        # a regular file. A symlink (ELOOP) is a closed refusal.
        fd = os.open(os.path.join(root, HISTORY),
                     os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    except OSError:
        refuse("unsafe_operator_file")
    st = os.fstat(fd)
    if (not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != os.geteuid()
            or st.st_mode & 0o077):
        os.close(fd)
        refuse("unsafe_operator_file")
    return fd


def complete_lines(fd, size):
    """Offset just past the last newline: everything after it is a fragment
    of an append that never finished, so it was never followed by a replace."""
    end = size
    while end > 0:
        start = max(0, end - 65536)
        chunk = b""
        while len(chunk) < end - start:
            # A short read covers only a prefix of the range; keep reading so
            # no unread bytes are skipped when choosing the cut.
            part = os.pread(fd, end - start - len(chunk), start + len(chunk))
            if not part:
                refuse("unsafe_operator_file")
            chunk += part
        at = chunk.rfind(b"\n")
        if at >= 0:
            return start + at + 1
        end = start
    return 0


def history_room(root, n):
    """Refuse operator_history_full unless n more bytes fit under MAX_HISTORY."""
    fd = history_file(root)
    try:
        room(fd, n)
    finally:
        os.close(fd)


def room(fd, n):
    keep = complete_lines(fd, os.fstat(fd).st_size)
    if keep + n > MAX_HISTORY:
        refuse("operator_history_full")
    return keep


def history(root, old):
    """Append the exact journal bytes about to be replaced, one per line, and
    make them durable before the replace. A crash after this append and
    before the replace leaves a duplicate of the current record at the tail;
    that is accepted. A torn earlier append is cut back to its last complete
    line first, and a failed write is cut back too, so every line is one
    whole record. History is capped at MAX_HISTORY (64 MiB): past it every
    commit refuses operator_history_full until retention exists (row 225)."""
    fd = history_file(root)
    try:
        data = old.encode() + b"\n"
        keep = room(fd, len(data))
        os.ftruncate(fd, keep)
        try:
            written = 0
            while written < len(data):
                written += os.write(fd, data[written:])
            os.fsync(fd)
        except OSError:
            # Make the cut durable too; if even that fails, the next append
            # still cuts the fragment back before writing.
            try:
                os.ftruncate(fd, keep)
                os.fsync(fd)
            except OSError:
                pass
            refuse("operator_history_write_failed")
    finally:
        os.close(fd)
    sync_dir(root)


def catalog_path(root, sha):
    return os.path.join(root, CATALOG, sha + ".json")


def catalog_paths(root, r):
    """A catalog artifact's path is derived from its digest, never supplied."""
    for a in r["artifacts"]:
        if a["kind"] == "catalog" and a["path"] != catalog_path(root, a["sha256"]):
            refuse("malformed_operator_plan")


def store_names(root):
    """Final envelope digests in catalog/ (none if it is absent) and its temp
    names. A temp must be a private regular file of this user and any other
    name is corruption."""
    path = os.path.join(root, CATALOG)
    try:
        if not stat.S_ISDIR(os.lstat(path).st_mode):
            refuse("catalog_store_corrupt")
        names = os.listdir(path)
    except FileNotFoundError:
        return [], []
    finals, temps = [], []
    for name in names:
        if re.fullmatch(r"[0-9a-f]{64}\.json", name):
            finals.append(name[:-5])
        elif re.fullmatch(r"\.tmp\.[0-9a-f]{32}", name):
            st = os.lstat(os.path.join(path, name))
            if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o077:
                refuse("catalog_store_corrupt")
            temps.append(name)
        else:
            refuse("catalog_store_corrupt")
    return finals, temps


def clear_temps(root, temps):
    """Remove leftover temps (already checked by store_names) and make the
    removal durable."""
    store = os.path.join(root, CATALOG)
    for name in temps:
        os.unlink(os.path.join(store, name))
    if temps:
        sync_dir(store)


def history_records(root):
    """Complete history lines, newest first. A line that is not a record is
    skipped here; the BEAM verifies history strictly."""
    path = os.path.join(root, HISTORY)
    try:
        if os.lstat(path).st_size > MAX_HISTORY:
            refuse("catalog_store_corrupt")
        raw = file_bytes(path, MAX_HISTORY, missing=True, private=True)
    except FileNotFoundError:
        return []
    except OSError:
        refuse("unsafe_operator_file")
    if raw is None:
        return []
    result = []
    for text in reversed(raw.split(b"\n")[:-1]):
        try:
            result.append(record(text.decode("utf-8")))
        except (Refusal, UnicodeError):
            continue
    return result


def catalog_receipts(root, old):
    """Committed head (the newest catalog artifact, journal then history) and
    every receipt digest in either."""
    head, shas = None, set()
    for r in ([] if old is None else [record(old)]) + history_records(root):
        for a in r["artifacts"]:
            if a["kind"] == "catalog":
                shas.add(a["sha256"])
                head = head or a["op_id"]
    return head, shas


def stage_head(root, old, next_record):
    head, shas = catalog_receipts(root, old)
    finals = set(store_names(root)[0])
    # A receipted envelope that is gone means the store is already corrupt.
    if shas - finals:
        refuse("catalog_store_corrupt")
    if head != next_record["catalog_head"] or finals - shas:
        refuse("stale_catalog_head")


def commit(root, old, raw, writes=None):
    """`writes` names the one phase the calling plan may record; None is the
    journal and stage plans, which only record carrier_pending."""
    next_record = record(raw)
    # Only the BEAM's own encoding is ever journaled, so later string
    # patterns and byte comparisons see one shape.
    if canonical(next_record) != raw:
        refuse("malformed_operator_plan")
    # Only activate() may write an activated record, ready() a ready one, and
    # so on, each after its own checks; an ordinary plan can neither create a
    # phase nor move an attempt's phase.
    if writes is None:
        if next_record["phase"] != "carrier_pending":
            refuse("stale_operator_intent")
    elif next_record["phase"] != writes or (writes != "activated" and old is None):
        refuse("stale_operator_intent")
    if old is not None and writes is None:
        old_record = record(old)
        if old_record["attempt"] == next_record["attempt"] and old_record != next_record:
            refuse("stale_operator_intent")
    catalog_paths(root, next_record)
    expected(root, old)
    current_service(next_record["service"])
    apart(root, next_record["service"]["identity_file"])
    if writes is None:
        stage_head(root, old, next_record)
    # Exclusive temp is deliberately preserved on failure; never guess that an orphan is disposable.
    temporary = os.path.join(root, "operator-journal.json.tmp." + os.urandom(16).hex())
    retain(temporary, raw.encode())
    expected(root, old)
    current_service(next_record["service"])
    # expected() has just proven the journal on disk is exactly `old`; no
    # journal (old is None) means there is nothing to keep.
    if old is not None:
        history(root, old)
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
    # commit() refuses a non-canonical record; say so before the manifest moves.
    if canonical(record(plan["record"])) != plan["record"]:
        refuse("malformed_operator_plan")
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
    absolute_paths(candidate, root)
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
        # The candidate keeps the replaced manifest's permission bits, so a
        # 0644 deployment file stays readable and a 0600 one stays private.
        mode = mode_of(target)
        history_room(root, len(plan["expected"].encode()) + 1)
        fd = os.open(temporary, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fchmod(fd, mode)
            os.fsync(fd)
        finally:
            os.close(fd)
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
    commit(root, plan["expected"], plan["record"], writes="activated")
    reply({"ok": True})


def ready(root, plan):
    """Record that the activated candidate is still the active manifest under
    the latest controlled boot. The BEAM has already proved its local facts
    (plan 223); this step only re-checks, under the lock, what the owner can
    see: the journal, the boot marker and the active bytes. It writes nothing
    but the journal, through the row 218 history append."""
    checks = plan["checks"]
    if (plan["artifacts"] is not None or type(plan["expected"]) is not str
            or type(plan["record"]) is not str or not op_id(plan["attempt"])
            or not hex_id(plan["incarnation"]) or not one_check(checks)):
        refuse("malformed_operator_plan")
    old = record(plan["expected"])
    manifests = [a for a in old["artifacts"] if a["kind"] == "manifest"]
    if len(manifests) != 1:
        refuse("corrupt_operator_journal")
    if (old["phase"] != "activated" or old["attempt"] != plan["attempt"]
            or record(plan["record"]) != dict(old, phase="ready")
            or checks[0]["sha256"] != manifests[0]["sha256"]):
        refuse("stale_operator_intent")
    # A later restart wrote a new marker, so readiness observed by an older
    # incarnation is never recorded.
    if file_bytes(os.path.join(root, INCARNATION), 64, missing=True, private=True) != plan["incarnation"].encode():
        refuse("stale_operator_incarnation")
    unchanged(root, plan, old, manifests[0])
    commit(root, plan["expected"], plan["record"], writes="ready")
    reply({"ok": True})


def unchanged(root, plan, old, manifest):
    """The checked manifest is no owner file, the journal is still `expected`
    and the active bytes are still the manifest artifact."""
    target = plan["checks"][0]["path"]
    if target in reserved(root, old):
        refuse("unsafe_operator_file")
    expected(root, plan["expected"])
    try:
        present = digest(file_bytes(target, allow_root=True))
    except FileNotFoundError:
        refuse("stale_operator_intent")
    except OSError:
        refuse("unsafe_operator_file")
    if present != manifest["sha256"]:
        refuse("stale_operator_intent")


def promoted(plan):
    """Shared start of the catalogued and listed plans: shape and the one manifest
    artifact of the old record."""
    checks = plan["checks"]
    if (type(plan["expected"]) is not str or type(plan["record"]) is not str
            or not op_id(plan["attempt"]) or not hex_id(plan["incarnation"]) or not one_check(checks)):
        refuse("malformed_operator_plan")
    old = record(plan["expected"])
    manifests = [a for a in old["artifacts"] if a["kind"] == "manifest"]
    if len(manifests) != 1:
        refuse("corrupt_operator_journal")
    return old, manifests[0]


def catalogued(root, plan):
    """Store the one signed catalog envelope the BEAM checked, under catalog/
    at a name derived from its digest, then record it. The owner binds bytes
    to digest only; the BEAM verified the signature. A retry after a crash
    between the store write and the commit finds the same bytes and commits."""
    arts = plan["artifacts"]
    if type(arts) is not list or len(arts) != 1 or not closed(arts[0], ["sha256", "bytes"]) \
            or not hex_id(arts[0]["sha256"]):
        refuse("malformed_operator_plan")
    old, manifest = promoted(plan)
    envelope = binary(arts[0]["bytes"])
    sha = arts[0]["sha256"]
    if digest(envelope) != sha or len(envelope) > MAX_CATALOG:
        refuse("malformed_operator_plan")
    new = record(plan["record"])
    found = [a for a in new["artifacts"] if a["kind"] == "catalog"]
    if len(found) == 1 and found[0]["sha256"] == sha and found[0]["path"] != catalog_path(root, sha):
        refuse("malformed_operator_plan")
    if (old["phase"] != "ready" or old["attempt"] != plan["attempt"] or len(found) != 1
            or found[0]["sha256"] != sha
            or new != dict(old, phase="catalogued", catalog_head=found[0]["op_id"],
                           artifacts=old["artifacts"] + found)
            or plan["checks"][0]["sha256"] != manifest["sha256"]):
        refuse("stale_operator_intent")
    if file_bytes(os.path.join(root, INCARNATION), 64, missing=True, private=True) != plan["incarnation"].encode():
        refuse("stale_operator_incarnation")
    unchanged(root, plan, old, manifest)
    if canonical(new) != plan["record"]:
        refuse("malformed_operator_plan")
    finals, temps = store_names(root)
    # A different envelope that no record names is a pending one: this chain
    # already forks. Replaying a receipted envelope, or one that names the
    # committed head again, is stale intent.
    _, receipts = catalog_receipts(root, plan["expected"])
    if any(f != sha and f not in receipts for f in finals):
        refuse("catalog_fork")
    if sha in receipts or found[0]["op_id"] == old["catalog_head"]:
        refuse("stale_operator_intent")
    store = os.path.join(root, CATALOG)
    try:
        os.mkdir(store, 0o700)
        sync_dir(root)
    except FileExistsError:
        pass
    directory(store)
    st = os.lstat(store)
    if st.st_uid != os.geteuid() or st.st_mode & 0o077:
        refuse("unsafe_operator_directory")
    history_room(root, len(plan["expected"].encode()) + 1)
    clear_temps(root, temps)
    final = catalog_path(root, sha)
    temporary = os.path.join(store, ".tmp." + os.urandom(16).hex())
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(envelope)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, final)
        except FileExistsError:
            if file_bytes(final, MAX_CATALOG, private=True) != envelope:
                refuse("immutable_artifact_conflict")
    finally:
        try:
            os.unlink(temporary)
        except OSError:
            pass
    sync_dir(store)
    if file_bytes(final, MAX_CATALOG, private=True) != envelope:
        refuse("immutable_artifact_conflict")
    expected(root, plan["expected"])
    commit(root, plan["expected"], plan["record"], writes="catalogued")
    reply({"ok": True})


def listed(root, plan):
    """Record the BEAM's receipt that the catalogued entry is served, after
    checking under the lock that the stored envelope is unchanged."""
    if plan["artifacts"] is not None:
        refuse("malformed_operator_plan")
    old, manifest = promoted(plan)
    if (old["phase"] != "catalogued" or old["attempt"] != plan["attempt"]
            or record(plan["record"]) != dict(old, phase="listed")
            or plan["checks"][0]["sha256"] != manifest["sha256"]):
        refuse("stale_operator_intent")
    if file_bytes(os.path.join(root, INCARNATION), 64, missing=True, private=True) != plan["incarnation"].encode():
        refuse("stale_operator_incarnation")
    unchanged(root, plan, old, manifest)
    for a in old["artifacts"]:
        if a["kind"] == "catalog":
            staged(a)
    commit(root, plan["expected"], plan["record"], writes="listed")
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
    if target in reserved_files(root):
        refuse("unsafe_operator_file")
    # The loaded bytes must still be active even with no journal yet, so a
    # first boot cannot serve a manifest replaced before this lock was taken.
    try:
        present = digest(file_bytes(target, allow_root=True))
    except FileNotFoundError:
        refuse("stale_operator_intent")
    except OSError:
        refuse("unsafe_operator_file")
    if present != loaded:
        refuse("stale_operator_intent")
    path = os.path.join(root, "operator-journal.json")
    raw = file_bytes(path, MAX_JOURNAL, missing=True, private=True)
    if raw is not None:
        raw = raw.decode("utf-8")
        old = record(raw)
        manifests = [a for a in old["artifacts"] if a["kind"] == "manifest"]
        if len(manifests) != 1:
            refuse("corrupt_operator_journal")
        candidate = manifests[0]["sha256"]
        if old["phase"] == "carrier_pending" and present == candidate != old["manifest_digest"]:
            for a in old["artifacts"]:
                staged(a)
            durable(target)
            history_room(root, len(raw.encode()) + 1)
            # The canonical record differs from its activated form in this one
            # structural member; a quote inside any string value is escaped,
            # so the pattern cannot match inside one.
            pending = '"phase":"carrier_pending"'
            if raw.count(pending) != 1:
                refuse("corrupt_operator_journal")
            activated = raw.replace(pending, '"phase":"activated"')
            if record(activated) != dict(old, phase="activated"):
                refuse("corrupt_operator_journal")
            commit(root, raw, activated, writes="activated")
        elif old["phase"] == "activated" and present == old["manifest_digest"] != candidate:
            refuse("stale_operator_intent")
        elif old["phase"] in ("ready", "catalogued", "listed") and present != candidate:
            # Ready describes the activated bytes; a restart does not undo
            # them, but any other active bytes contradict the record.
            refuse("stale_operator_intent")
    # A kill between a publish link and its temp unlink leaves a final with
    # two links; no publish is running under this lock, so clear the temps.
    clear_temps(root, store_names(root)[1])
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


def absolute_paths(raw, root):
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
            apart(root, path)


def apart(root, path):
    """A deployment path that names one of the operator's own files, by path
    or by inode, would be rewritten by the next journal, history or marker
    write; the BEAM boot refuses the same collision."""
    own = reserved_files(root)
    if os.path.normpath(path) in own:
        refuse("operator_path_collision")
    try:
        st = os.stat(path)
    except OSError:
        return
    store = os.path.join(root, CATALOG)
    try:
        listing = [os.path.join(store, n) for n in os.listdir(store)]
    except OSError:
        listing = []
    for name in list(own) + [store] + listing:
        try:
            other = os.stat(name)
        except OSError:
            continue
        if (st.st_dev, st.st_ino) == (other.st_dev, other.st_ino):
            refuse("operator_path_collision")


class Reserved(set):
    """Exact owner files plus everything at or under catalog/."""
    def __init__(self, items, root):
        super().__init__(items)
        self.store = os.path.join(root, CATALOG)

    def __contains__(self, path):
        return (set.__contains__(self, path) or path == self.store
                or (type(path) is str and path.startswith(self.store + os.sep)))


def reserved(root, r):
    """Paths activation must never replace: the lock it holds, the journal it
    commits and its history, the boot incarnation marker it checks and the
    staged artifacts it rechecks."""
    return Reserved(reserved_files(root) | {a["path"] for a in r["artifacts"]}, root)


def reserved_files(root):
    """The operator's own files under its root."""
    return Reserved({os.path.join(root, "operator.lock"), os.path.join(root, "operator-journal.json"),
                     os.path.join(root, INCARNATION), os.path.join(root, HISTORY)}, root)


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


def mode_of(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        refuse("unsafe_operator_file")
    try:
        st = os.fstat(fd)
    finally:
        os.close(fd)
    # The carrier refuses a group- or other-writable manifest; never copy one.
    # Only the permission bits carry over, never setuid, setgid or sticky.
    if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o022:
        refuse("unsafe_operator_file")
    return st.st_mode & 0o777


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
    if plan["kind"] in ("ready", "catalogued", "listed"):
        if plan["record"] is None:
            refuse("malformed_operator_plan")
        {"ready": ready, "catalogued": catalogued, "listed": listed}[plan["kind"]](root, plan)
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
