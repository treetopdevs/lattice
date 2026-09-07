import importlib.util
import json
import pathlib
import shutil
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("verify_upstream", ROOT / "scripts/verify_upstream.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

class VerifyUpstreamTest(unittest.TestCase):
    def test_source_tamper_and_unlisted_file_are_refused(self):
        lock = json.loads((ROOT / "upstream.lock.json").read_text())
        with tempfile.TemporaryDirectory() as directory:
            vendor = pathlib.Path(directory)
            for name, digest in lock["files"].items():
                path = vendor / name
                path.parent.mkdir(parents=True, exist_ok=True)
                source = ROOT / "vendor/android-keyattestation" / name
                shutil.copy2(source, path)
            MODULE.verify(ROOT / "upstream.lock.json", vendor)
            self.assertEqual(lock["gitTree"], MODULE.git_tree(vendor))
            target = vendor / next(iter(lock["files"]))
            target.write_bytes(target.read_bytes() + b"tamper")
            with self.assertRaisesRegex(ValueError, "changed="):
                MODULE.verify(ROOT / "upstream.lock.json", vendor)
            target.write_bytes((ROOT / "vendor/android-keyattestation" / target.relative_to(vendor)).read_bytes())
            (vendor / "unlisted").write_text("x")
            with self.assertRaisesRegex(ValueError, "added="):
                MODULE.verify(ROOT / "upstream.lock.json", vendor)

if __name__ == "__main__": unittest.main()
