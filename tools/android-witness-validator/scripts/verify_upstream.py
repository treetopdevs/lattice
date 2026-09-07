#!/usr/bin/env python3
import hashlib
import json
import pathlib
import sys

def git_object(kind: bytes, payload: bytes) -> bytes:
    return hashlib.sha1(kind + b" " + str(len(payload)).encode() + b"\0" + payload).digest()

def git_tree(directory: pathlib.Path) -> str:
    entries = []
    for path in sorted(directory.iterdir(), key=lambda item: item.name.encode() + (b"/" if item.is_dir() else b"")):
        if path.is_dir():
            mode, digest = b"40000", bytes.fromhex(git_tree(path))
        elif path.is_file():
            mode = b"100755" if path.stat().st_mode & 0o111 else b"100644"
            digest = git_object(b"blob", path.read_bytes())
        else:
            raise ValueError(f"unsupported upstream entry {path}")
        entries.append(mode + b" " + path.name.encode() + b"\0" + digest)
    return git_object(b"tree", b"".join(entries)).hex()

def verify(lock_path: pathlib.Path, vendor: pathlib.Path) -> None:
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    if lock.get("repository") != "https://github.com/android/keyattestation.git":
        raise ValueError("unexpected upstream repository")
    if lock.get("commit") != "a48898a68337b920cbd368eab5824f696d7bbf3d":
        raise ValueError("unexpected upstream commit")
    if lock.get("gitTree") != "1e7bcbf19e46fcf68004ca99b34fcbe017bc2dee":
        raise ValueError("unexpected upstream tree")
    expected = lock.get("files")
    if not isinstance(expected, dict) or not expected:
        raise ValueError("missing upstream manifest")
    actual = {
        str(path.relative_to(vendor)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(vendor.rglob("*")) if path.is_file()
    }
    if actual != expected:
        missing = sorted(set(expected) - set(actual))
        added = sorted(set(actual) - set(expected))
        changed = sorted(name for name in set(actual) & set(expected) if actual[name] != expected[name])
        raise ValueError(f"upstream source mismatch missing={missing} added={added} changed={changed}")
    if git_tree(vendor) != lock["gitTree"]:
        raise ValueError("upstream git tree mismatch")

if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: verify_upstream.py LOCK VENDOR")
    try:
        verify(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))
    except Exception as error:
        print(f"REFUSED: {error}", file=sys.stderr)
        raise SystemExit(1)
