#!/usr/bin/env python3
"""Custodian-only public ledger writer. Never receives or reads a signing seed.

One process holds flock from snapshot through fsync/reopen/ACK. BEAM verifies
signatures and chain semantics under that lock. Linux operator mutation remains
in its separate, Linux-only owner. This helper supports macOS and Linux.
"""
import fcntl
import hashlib
import json
import os
import re
import signal
import stat
import sys
import tempfile

CAP = 131072
TOTAL = 67108864


class Refusal(Exception):
    pass


def require(ok, reason="catalog_ledger_corrupt"):
    if not ok:
        raise Refusal(reason)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def read_line():
    line = sys.stdin.buffer.readline(TOTAL + 1)
    require(line.endswith(b"\n") and len(line) <= TOTAL, "catalog_ledger_protocol")
    return json.loads(line)


def emit(value):
    print(canonical(value), flush=True)


def private(path, directory=False, links=1):
    info = os.lstat(path)
    require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            and info.st_uid == os.getuid() and not info.st_mode & 0o077
            and (directory or info.st_nlink == links), "unsafe_catalog_ledger")
    return info


def secure_root(path):
    require(os.path.isabs(path) and os.path.realpath(path) == path, "unsafe_catalog_ledger")
    private(path, directory=True)
    parent = os.path.dirname(path)
    while True:
        info = os.lstat(parent)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, os.getuid())
                and (not info.st_mode & 0o022 or info.st_mode & stat.S_ISVTX),
                "unsafe_catalog_ledger")
        if parent == os.path.dirname(parent):
            return
        parent = os.path.dirname(parent)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read(path):
    before = private(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        require((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino))
        require(opened.st_size <= CAP)
        data = os.read(fd, CAP + 1)
        after = os.lstat(path)
        require(len(data) == opened.st_size and
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) ==
                (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns))
        return data.decode("utf-8")
    finally:
        os.close(fd)


def clean_temps(root):
    # Only unpublished scratch names are discarded. A kill between link and
    # unlink may leave two links to one committed envelope; removing scratch
    # restores its single-link invariant before any snapshot is exposed.
    for name in os.listdir(root):
        if name.startswith(".tmp-"):
            path = os.path.join(root, name)
            info = os.lstat(path)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                    and not info.st_mode & 0o077 and info.st_nlink in (1, 2),
                    "unsafe_catalog_ledger")
            os.unlink(path)
    sync_dir(root)


def write(root, name, data, replace=False):
    require(isinstance(data, str) and len(data.encode()) <= CAP, "catalog_ledger_capacity")
    target = os.path.join(root, name)
    if os.path.lexists(target):
        previous = read(target)
        if previous == data:
            return
        require(replace, "catalog_ledger_fork")
    fd, temporary = tempfile.mkstemp(prefix=".tmp-", dir=root)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(data.encode())
            output.flush()
            os.fsync(output.fileno())
        if replace:
            os.replace(temporary, target)
        else:
            os.link(temporary, target, follow_symlinks=False)
            os.unlink(temporary)
        sync_dir(root)
        require(read(target) == data)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def snapshot(root):
    names = os.listdir(root)
    require(len(names) <= 514, "catalog_ledger_capacity")
    require(all(name in ("lock", "head.json") or re.fullmatch(r"[0-9a-f]{64}\.json", name)
                for name in names))
    envelopes = []
    for name in sorted(names):
        if name not in ("lock", "head.json"):
            data = read(os.path.join(root, name))
            require(hashlib.sha256(data.encode()).hexdigest() + ".json" == name)
            envelopes.append(data)
    require(sum(len(x.encode()) for x in envelopes) <= TOTAL)
    head = read(os.path.join(root, "head.json")) if "head.json" in names else None
    require(head is not None or not envelopes)
    return {"head": head, "envelopes": envelopes}


def head_shape(value, binding, key):
    require(isinstance(value, dict) and set(value) == {"binding", "key", "revision", "id"})
    require(value["binding"] == binding and value["key"] == key)
    require((value["revision"] is None and value["id"] is None) or
            (type(value["revision"]) is int and 0 <= value["revision"] <= 512
             and isinstance(value["id"], str)))


def main():
    require(sys.platform in ("darwin", "linux"), "unsupported_catalog_ledger_platform")
    requested = os.path.abspath(sys.argv[1])
    original = private(requested, directory=True)
    ceremony = os.path.realpath(requested)
    secure_root(ceremony)
    resolved = os.lstat(ceremony)
    require((original.st_dev, original.st_ino) == (resolved.st_dev, resolved.st_ino),
            "unsafe_catalog_ledger")
    plan = read_line()
    require(set(plan) == {"action", "binding", "key"} and plan["action"] in ("init", "open"),
            "catalog_ledger_protocol")
    root = os.path.join(ceremony, "catalog-signing")
    if not os.path.lexists(root):
        require(plan["action"] == "init", "catalog_ledger_uninitialized")
        os.mkdir(root, 0o700)
        sync_dir(ceremony)
    private(root, directory=True)
    lock = os.path.join(root, "lock")
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        checked = private(lock)
        held = os.fstat(fd)
        require((held.st_dev, held.st_ino) == (checked.st_dev, checked.st_ino))
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refusal("catalog_ledger_busy")
        # No BEAM callback can outlive this lock-owning process. A bounded
        # deadline kills the session; no ACK means no signature may escape.
        signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(Refusal("catalog_ledger_timeout")))
        signal.alarm(30)
        clean_temps(root)
        current = snapshot(root)
        if current["head"] is None:
            require(plan["action"] == "init", "catalog_ledger_uninitialized")
            genesis = {"binding": plan["binding"], "key": plan["key"], "revision": None, "id": None}
            write(root, "head.json", canonical(genesis))
            current = snapshot(root)
        old = json.loads(current["head"])
        head_shape(old, plan["binding"], plan["key"])
        emit(current)
        command = read_line()
        require(set(command) == {"head", "envelope"}, "catalog_ledger_protocol")
        next_head = json.loads(command["head"])
        head_shape(next_head, plan["binding"], plan["key"])
        if command["envelope"] is None:
            require(command["head"] == current["head"], "catalog_ledger_fork")
        else:
            require(plan["action"] == "open" and isinstance(command["envelope"], str))
            require(next_head["revision"] == (0 if old["revision"] is None else old["revision"] + 1)
                    or next_head == old, "catalog_ledger_fork")
            data = command["envelope"]
            name = hashlib.sha256(data.encode()).hexdigest() + ".json"
            write(root, name, data)
            write(root, "head.json", command["head"], replace=True)
        after = snapshot(root)
        require(after["head"] == command["head"])
        emit({"ok": True})
    finally:
        os.close(fd)


if __name__ == "__main__":
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    try:
        main()
    except Refusal as error:
        emit({"error": str(error)})
        sys.exit(1)
    except Exception:
        emit({"error": "catalog_ledger_failed"})
        sys.exit(1)
