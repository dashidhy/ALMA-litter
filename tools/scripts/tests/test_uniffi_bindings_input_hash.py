import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPT_PATH = Path(__file__).parents[1] / "uniffi-bindings-input-hash.sh"


class BindingInputHashTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="binding inputs ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.script = self.root / "ALMA-litter/tools/scripts" / SCRIPT_PATH.name
        self.script.parent.mkdir(parents=True)
        shutil.copyfile(SCRIPT_PATH, self.script)
        self.inputs = [
            "ALMA-litter/shared/rust-bridge/Cargo.toml",
            "ALMA-litter/shared/rust-bridge/Cargo.lock",
            "ALMA-litter/shared/rust-bridge/codex-mobile-client/Cargo.toml",
            "ALMA-litter/shared/rust-bridge/codex-mobile-client/src/lib.rs",
            "ALMA-codex/codex-rs/Cargo.toml",
            "ALMA-codex/codex-rs/app-server-protocol/Cargo.toml",
            "ALMA-codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs",
            "ALMA-codex/codex-rs/protocol/Cargo.toml",
            "ALMA-codex/codex-rs/protocol/src/lib.rs",
            "ALMA-codex/ios/Cargo.toml",
            "ALMA-codex/ios/native/Cargo.toml",
            "ALMA-codex/ios/native/src/auth_refresh.rs",
            "ALMA-codex/ios/native/src/runtime_bootstrap.rs",
            "ALMA-codex/ios/native/src/cacert.pem",
            "ALMA-kimi-code/ios/native/Cargo.toml",
            "ALMA-kimi-code/ios/native/src/kimi_backend.rs",
            "ALMA-kimi-code/ios/native/src/kimi_assets.rs",
        ]
        for relative in self.inputs:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("baseline\n")

    def run_script(self, *args, local="0"):
        return subprocess.run(
            ["bash", str(self.script), *map(str, args)],
            capture_output=True,
            text=True,
            env=dict(os.environ, LITTER_ALMA_LOCAL=local),
        )

    def digest(self, **kwargs):
        result = self.run_script(**kwargs)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r"\A[0-9a-f]{64}\n\Z")
        return result.stdout

    def test_stable_hash_and_local_build_selection(self):
        baseline = self.digest()
        self.assertEqual(self.digest(), baseline)
        self.assertNotEqual(self.digest(local="1"), baseline)

    def test_each_source_and_manifest_invalidates_hash(self):
        baseline = self.digest()
        for relative in self.inputs:
            with self.subTest(path=relative):
                path = self.root / relative
                path.write_text("changed\n")
                self.assertNotEqual(self.digest(), baseline)
                path.write_text("baseline\n")
                self.assertEqual(self.digest(), baseline)

    def test_added_and_removed_fork_source_invalidates_hash(self):
        baseline = self.digest()
        path = self.root / "ALMA-codex/ios/native/src/new_module.rs"
        path.write_text("new module\n")
        self.assertNotEqual(self.digest(), baseline)
        path.unlink()
        self.assertEqual(self.digest(), baseline)

    def test_newer_than_uses_fork_sources(self):
        stamp = self.root / "bindings.stamp"
        self.assertEqual(self.run_script("--newer-than", stamp).returncode, 0)
        for path in [self.script, *(self.root / relative for relative in self.inputs)]:
            os.utime(path, (100, 100))
        stamp.touch()
        os.utime(stamp, (200, 200))
        self.assertEqual(self.run_script("--newer-than", stamp).returncode, 1)
        for relative in self.inputs:
            with self.subTest(path=relative):
                path = self.root / relative
                os.utime(path, (300, 300))
                self.assertEqual(self.run_script("--newer-than", stamp).returncode, 0)
                os.utime(path, (100, 100))

    def test_missing_fork_fails_in_both_modes(self):
        shutil.rmtree(self.root / "ALMA-kimi-code/ios/native/src")
        for args in [(), ("--newer-than", self.root / "missing.stamp")]:
            with self.subTest(args=args):
                result = self.run_script(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
