"""Regression tests for both metadata actions, including deliberately broken packages."""
import importlib.util
import io
import json
from pathlib import Path
import re
import subprocess
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('package_check', Path(__file__).with_name('check-package.py'))
package_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package_check)
ACTIONS = [('refresh-metadata', 'refresh'), ('refresh-publication', 'retrieve-metadata')]


class MetadataMenuIconRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        """Compile real source themes; never depend on an old build directory."""
        result = subprocess.run(['node', '-e', """
            const sass = require('sass');
            const themes = Object.fromEntries(['mac', 'win', 'unix'].map(platform => [platform,
                sass.renderSync({ file: `scss/zotero-${platform}.scss`, outputStyle: 'compressed',
                    logger: sass.Logger.silent }).css.toString()]));
            process.stdout.write(JSON.stringify(themes));
        """], cwd=ROOT, check=True, capture_output=True, text=True)
        cls.files = {'chrome/content/zotero/zoteroPane.xhtml': (ROOT / 'chrome/content/zotero/zoteroPane.xhtml').read_text()}
        for platform, css in json.loads(result.stdout).items():
            cls.files[f'chrome/content/zotero-platform/{platform}/zotero.css'] = css
        for _, icon in ACTIONS:
            path = f'chrome/skin/default/zotero/16/universal/{icon}.svg'
            cls.files[path] = (ROOT / path).read_text()

    def check_archive(self, files):
        """Exercise the release checker on an isolated in-memory app archive."""
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as archive:
            for path, text in files.items():
                archive.writestr(path, text)
        stream.seek(0)
        with zipfile.ZipFile(stream) as archive:
            package_check.check_menu_icons(archive)

    def test_both_actions_ship_icons_in_all_three_compiled_themes(self):
        self.check_archive(self.files)

    def test_missing_mapping_reproduces_each_original_iconless_action(self):
        for action, _ in ACTIONS:
            for platform in ['mac', 'win', 'unix']:
                with self.subTest(action=action, platform=platform):
                    files = dict(self.files)
                    path = f'chrome/content/zotero-platform/{platform}/zotero.css'
                    files[path] = re.sub(r'\.zotero-menuitem-' + action + r'\s*\{[^{}]*\}', '', files[path])
                    with self.assertRaisesRegex(AssertionError, action + '/' + platform):
                        self.check_archive(files)

    def test_native_and_in_content_mappings_are_both_required(self):
        for action, _ in ACTIONS:
            for prop in ['list-style-image', '--menuitem-icon']:
                with self.subTest(action=action, property=prop):
                    files = dict(self.files)
                    path = 'chrome/content/zotero-platform/mac/zotero.css'
                    files[path] = re.sub(r'(\.zotero-menuitem-' + action + r'\s*\{)([^{}]*)(\})',
                        lambda m: m[1] + re.sub(re.escape(prop) + r'\s*:[^;]+;', '', m[2]) + m[3], files[path])
                    with self.assertRaisesRegex(AssertionError, re.escape(prop)):
                        self.check_archive(files)

    def test_missing_iconic_class_is_rejected_for_each_action(self):
        for action, _ in ACTIONS:
            with self.subTest(action=action):
                files = dict(self.files)
                path = 'chrome/content/zotero/zoteroPane.xhtml'
                files[path] = files[path].replace('menuitem-iconic zotero-menuitem-' + action, 'zotero-menuitem-' + action)
                with self.assertRaisesRegex(AssertionError, action + ': missing iconic'):
                    self.check_archive(files)

    def test_missing_blank_oversized_and_hardcoded_color_assets_are_rejected(self):
        for action, icon in ACTIONS:
            for failure in ['missing', 'blank', 'size', 'color']:
                with self.subTest(action=action, failure=failure):
                    files = dict(self.files)
                    path = f'chrome/skin/default/zotero/16/universal/{icon}.svg'
                    if failure == 'missing':
                        del files[path]
                    elif failure == 'blank':
                        files[path] = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>'
                    elif failure == 'size':
                        files[path] = files[path].replace('width="16"', 'width="24"', 1)
                    else:
                        files[path] = files[path].replace('context-fill', '#fff')
                    with self.assertRaisesRegex(AssertionError, action):
                        self.check_archive(files)


if __name__ == '__main__':
    unittest.main()
