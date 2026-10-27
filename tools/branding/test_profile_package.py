"""Reject identity regressions in assembled bundles, using disposable package fixtures."""
import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('package_check', Path(__file__).with_name('check-package.py'))
package_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package_check)


class ProfilePackageTests(unittest.TestCase):
    def setUp(self):
        """Use real build inputs and the real release gate, without modifying staging."""
        temporary = tempfile.TemporaryDirectory(prefix='epilib-package-identity-')
        self.addCleanup(temporary.cleanup)
        self.resources = Path(temporary.name)
        (self.resources / 'app').mkdir()
        self.config = json.loads((ROOT / 'tools/branding/config.json').read_text())
        self.ini = (ROOT / 'app/assets/application.ini').read_text()
        self.runtime = (ROOT / 'resource/config.mjs').read_text()
        self.info = plistlib.loads((ROOT / 'app/mac/Contents/Info.plist').read_bytes())

    def verify(self, *, ini=None, runtime=None, info=None):
        """Assemble a minimal identity-bearing package, then run its production gate."""
        (self.resources / 'app/application.ini').write_text(self.ini if ini is None else ini)
        with zipfile.ZipFile(self.resources / 'app/omni.ja', 'w') as archive:
            archive.writestr('resource/config.mjs', self.runtime if runtime is None else runtime)
        package_check.check_runtime_identity(self.resources, self.config, self.info if info is None else info)

    def test_current_package_and_supported_build_channels_pass(self):
        for suffix in ['', '-source', '-dev', '-beta']:
            with self.subTest(channel=suffix):
                self.verify(info={**self.info, 'CFBundleIdentifier': 'org.epilib.epilib' + suffix})

    def test_stale_name_or_vendor_reproduces_shared_zotero_profile_failure(self):
        for key in ['Name', 'Vendor']:
            with self.subTest(key=key):
                with self.assertRaisesRegex(AssertionError, 'Runtime identity changed: ' + key):
                    self.verify(ini=self.ini.replace(f'{key}=EpiLib', f'{key}=Zotero'))

    def test_renaming_extension_id_is_not_required_for_filesystem_isolation(self):
        with self.assertRaisesRegex(AssertionError, 'Runtime identity changed: ID'):
            self.verify(ini=self.ini.replace('ID=zotero@zotero.org', 'ID=epilib@epilib.org'))

    def test_stale_data_folder_and_scratch_bundle_names_are_rejected(self):
        for key, old in [('DATA_DIRECTORY_NAME', 'Zotero'), ('BUNDLE_ID', 'org.zotero.zotero')]:
            with self.subTest(key=key):
                current = self.config['runtimeIdentity'][key]
                with self.assertRaisesRegex(AssertionError, 'Packaged identity changed: ' + key):
                    self.verify(runtime=self.runtime.replace(f"{key}: '{current}'", f"{key}: '{old}'"))

    def test_internal_database_and_preference_compatibility_ids_remain_stable(self):
        for key in ['ID', 'GUID', 'PREF_BRANCH']:
            with self.subTest(key=key):
                value = self.config['runtimeIdentity'][key]
                with self.assertRaisesRegex(AssertionError, 'Packaged identity changed: ' + key):
                    self.verify(runtime=self.runtime.replace(f"{key}: '{value}'", f"{key}: 'renamed'"))

    def test_old_macos_identity_and_unrecognized_channels_are_rejected(self):
        for bundle in ['org.zotero.zotero', 'org.zotero.zotero-source', 'org.epilib.epilib-unknown']:
            with self.subTest(bundle=bundle):
                with self.assertRaisesRegex(AssertionError, 'Shared macOS application identity'):
                    self.verify(info={**self.info, 'CFBundleIdentifier': bundle})


if __name__ == '__main__':
    unittest.main()
