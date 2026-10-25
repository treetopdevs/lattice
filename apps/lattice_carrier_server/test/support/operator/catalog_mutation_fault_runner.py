"""Kill the actual Linux mutation owner at a publication boundary; public plan only."""
import importlib.util
import io
import os
import signal
import sys

sys.dont_write_bytecode = True
helper, root, stage, plan = sys.argv[1:]
spec = importlib.util.spec_from_file_location("operator_owner", helper)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
original_link = owner.os.link
original_replace = owner.os.replace


def link(source, target, **kwargs):
    original_link(source, target, **kwargs)
    if stage == "link" and os.path.dirname(target) == os.path.join(root, "catalog"):
        os.kill(os.getpid(), signal.SIGKILL)


def replace(source, target, **kwargs):
    original_replace(source, target, **kwargs)
    if stage == "journal" and target == os.path.join(root, "operator-journal.json"):
        os.kill(os.getpid(), signal.SIGKILL)


owner.os.link = link
owner.os.replace = replace
sys.argv = [helper, root]
sys.stdin = io.TextIOWrapper(io.BytesIO((plan + "\n").encode()))
owner.main()
