"""Fault injection around the production public ledger owner; no seed inputs."""
import importlib.util
import io
import json
import os
import signal
import stat
import sys
import time

sys.dont_write_bytecode = True
helper, ceremony, scenario, plan, command = sys.argv[1:]
spec = importlib.util.spec_from_file_location("catalog_owner", helper)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
signal.signal(signal.SIGPIPE, signal.SIG_DFL)
events = []
original_write = owner.write
original_link = owner.os.link
original_replace = owner.os.replace
original_sync = owner.durable_sync
original_dir = owner.sync_dir
original_alarm = signal.alarm


def link(source, target, **kwargs):
    if scenario == "init_before_link" and os.path.basename(target) == "head.json":
        os.kill(os.getpid(), signal.SIGKILL)
    original_link(source, target, **kwargs)
    events.append(["link", os.path.basename(target)])
    if scenario == "init_after_link" and os.path.basename(target) == "head.json":
        os.kill(os.getpid(), signal.SIGKILL)


def replace(source, target, **kwargs):
    original_replace(source, target, **kwargs)
    events.append(["replace", os.path.basename(target)])


def durable(fd):
    kind = "dir" if stat.S_ISDIR(os.fstat(fd).st_mode) else "file"
    events.append(["durable", kind])
    original_sync(fd)


def directory(path):
    original_dir(path)
    events.append(["directory_done", os.path.basename(path)])


def write(root, name, data, replace=False):
    if name != "head.json":
        if scenario == "delayed_write":
            time.sleep(1.5)
        if scenario == "stdout_loss":
            sys.stdout.flush()
            os.close(sys.stdout.fileno())
    return original_write(root, name, data, replace)


owner.os.link = link
owner.os.replace = replace
owner.durable_sync = durable
owner.sync_dir = directory
owner.write = write
if scenario in ("alarm", "delayed_write"):
    signal.alarm = lambda seconds: original_alarm(1 if seconds else 0)

if scenario == "darwin_dispatch":
    # Dispatch spy only; actual Darwin tests exercise real F_FULLFSYNC separately.
    owner.sys.platform = "darwin"
    owner.fcntl.F_FULLFSYNC = getattr(owner.fcntl, "F_FULLFSYNC", 51)
    original_fcntl = owner.fcntl.fcntl

    def full_sync(fd, operation, *args):
        if operation == owner.fcntl.F_FULLFSYNC:
            kind = "dir" if stat.S_ISDIR(os.fstat(fd).st_mode) else "file"
            events.append(["fullfsync", kind])
            return 0
        return original_fcntl(fd, operation, *args)

    owner.fcntl.fcntl = full_sync


class SlowInput:
    def __init__(self):
        self.buffer = self
        self.calls = 0

    def readline(self, _cap):
        self.calls += 1
        if self.calls == 1:
            return (plan + "\n").encode()
        time.sleep(2)
        return (command + "\n").encode()


sys.argv = [helper, ceremony]
sys.stdin = SlowInput() if scenario == "alarm" else io.TextIOWrapper(
    io.BytesIO((plan + "\n" + command + "\n").encode()))
try:
    owner.main()
    print("TEST_EVENTS=" + json.dumps(events), flush=True)
except owner.Refusal as error:
    owner.emit({"error": str(error)})
    sys.exit(1)
except OSError:
    # A deliberately closed stdout must not print a misleading ACK or traceback.
    os._exit(3)
