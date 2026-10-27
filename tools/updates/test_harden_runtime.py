"""Regression coverage for fail-closed Gecko patching and packaged executables."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('hardener', Path(__file__).with_name('harden-runtime.py'))
hardener = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hardener)


class RuntimeIsolation(unittest.TestCase):
    def test_patch_is_exact_and_idempotent(self):
        for anchor, guard in hardener.PATCHES.values():
            original = anchor + '    return false;\n  }\n'
            patched = hardener.patch_source(original, anchor, guard)
            self.assertIn(anchor + guard, patched)
            self.assertEqual(hardener.patch_source(patched, anchor, guard), patched)
            for invalid in ['', original + original]:
                with self.assertRaises(ValueError):
                    hardener.patch_source(invalid, anchor, guard)

    def test_all_platform_packages_omit_updater_and_preserve_unrelated_resources(self):
        for name in ['EpiLib.app', 'Zotero_linux-x86_64', 'Zotero_win-x64']:
            with self.subTest(platform=name), tempfile.TemporaryDirectory() as temporary:
                bundle = Path(temporary) / name
                resources = bundle / 'Contents/Resources' if name.endswith('.app') else bundle
                resources.mkdir(parents=True)
                archive = resources / 'omni.ja'
                with zipfile.ZipFile(archive, 'w') as zipped:
                    for module, (anchor, _) in hardener.PATCHES.items():
                        zipped.writestr(module, anchor + '    return false;\n  }\n')
                    zipped.writestr('unrelated-resource', b'keep me')
                updater = bundle / 'Contents/MacOS/updater.app'
                updater.mkdir(parents=True)
                for filename in ['updater', 'updater.exe', 'updater.ini']:
                    (resources / filename).write_text('must not ship')
                hardener.harden(bundle)
                hardener.harden(bundle)
                self.assertFalse(updater.exists())
                self.assertFalse((resources / 'updater.exe').exists())
                self.assertFalse((resources / 'updater').exists())
                with zipfile.ZipFile(archive) as zipped:
                    self.assertEqual(zipped.read('unrelated-resource'), b'keep me')
                    for module, (anchor, guard) in hardener.PATCHES.items():
                        self.assertIn(anchor + guard, zipped.read(module).decode())

    def test_changed_upstream_keeps_original_archive_and_fails_build(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = Path(temporary)
            archive = bundle / 'omni.ja'
            with zipfile.ZipFile(archive, 'w') as zipped:
                for module in hardener.PATCHES:
                    zipped.writestr(module, 'upstream changed')
            original = archive.read_bytes()
            with self.assertRaises(ValueError):
                hardener.harden(bundle)
            self.assertEqual(archive.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
