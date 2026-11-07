"""The App accepts only Cargo-generated files matching the pinned V8 inputs."""
from pathlib import Path
import shutil
import tempfile
import unittest
from native_v8_inputs import verified_environment
from provider_sources import REPO


class GeneratedBindingsTests(unittest.TestCase):
    def test_exact_generated_files_and_rejections(self):
        original = REPO.parent / 'ALMA-codex'
        with tempfile.TemporaryDirectory(prefix='v8-input-check-') as temporary:
            fork = Path(temporary)
            (fork / 'ios/build').mkdir(parents=True)
            shutil.copyfile(original / 'ios/build/prepare_native_v8.py', fork / 'ios/build/prepare_native_v8.py')
            (fork / 'ios/inputspins').mkdir()
            for name in ['native_v8_inputs.json', 'v8-source-lock.json']:
                shutil.copyfile(original / 'ios/inputspins' / name, fork / 'ios/inputspins' / name)
            source = fork / 'ios/.build/vendor/codex-v8'
            shutil.copytree(original / 'ios/.build/vendor/codex-v8', source)
            verified_environment(fork)
            for name in ['gen/src_binding_release_aarch64-apple-ios.rs', 'gen/src_binding_release_aarch64-apple-ios.sum', 'build.rs']:
                file = source / name
                content = file.read_bytes()
                file.write_bytes(content + b'\nchanged\n')
                with self.assertRaises(Exception):
                    verified_environment(fork)
                file.write_bytes(content)
            extra = source / 'unreviewed.rs'
            extra.write_text('unreviewed')
            with self.assertRaises(Exception):
                verified_environment(fork)
            extra.unlink()
            binding = source / 'gen/src_binding_release_aarch64-apple-ios.rs'
            content = binding.read_bytes()
            binding.unlink()
            binding.symlink_to(original / 'ios/.build/vendor/codex-v8/gen/src_binding_release_aarch64-apple-ios.rs')
            with self.assertRaises(Exception):
                verified_environment(fork)
            binding.unlink()
            binding.write_bytes(content)
            verified_environment(fork)


if __name__ == '__main__':
    unittest.main()
