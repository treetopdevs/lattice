"""Kill the actual Linux mutation owner at a publication boundary; public plan only."""
import importlib.util
import io
import os
import signal
import sys

sys.dont_write_bytecode = True
helper, root, stage = sys.argv[1:4]
plan = sys.argv[4] if len(sys.argv) == 5 else sys.stdin.readline().rstrip("\n")
spec = importlib.util.spec_from_file_location("operator_owner", helper)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
original_link = owner.os.link
original_replace = owner.os.replace
original_reply = owner.reply


def link(source, target, **kwargs):
    original_link(source, target, **kwargs)
    if stage == "link" and os.path.dirname(target) == os.path.join(root, "catalog"):
        os.kill(os.getpid(), signal.SIGKILL)


def replace(source, target, **kwargs):
    if stage == "before_journal" and target == os.path.join(root, "operator-journal.json"):
        os.kill(os.getpid(), signal.SIGKILL)
    original_replace(source, target, **kwargs)
    if stage == "journal" and target == os.path.join(root, "operator-journal.json"):
        os.kill(os.getpid(), signal.SIGKILL)


def reply(value):
    if stage == "reply" and value == {"ok": True}:
        os.kill(os.getpid(), signal.SIGKILL)
    original_reply(value)


owner.os.link = link
owner.os.replace = replace
owner.reply = reply
sys.argv = [helper, root]
sys.stdin = io.TextIOWrapper(io.BytesIO((plan + "\n").encode()))
owner.main()
