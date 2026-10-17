"""Verify the finished desktop bundle, not just the source/build directory."""
import argparse
import base64
import configparser
import hashlib
import json
from pathlib import Path
import plistlib
import re
import zipfile


def check(bundle):
    root = Path(__file__).resolve().parents[2]
    config = json.loads((root / 'tools/branding/config.json').read_text())
    approved = json.loads((root / 'tools/branding/approved-assets.json').read_text())
    name = config['productName']
    mac = bundle.suffix == '.app'
    resources = bundle / 'Contents/Resources' if mac else bundle
    app = resources / 'app'
    ini = configparser.ConfigParser(interpolation=None)
    ini.read(app / 'application.ini')
    for key, value in {'Name': 'Zotero', 'Vendor': 'Zotero', 'ID': 'zotero@zotero.org'}.items():
        assert ini['App'][key] == value, f'Runtime identity changed: {key}'
    assert ini['AppUpdate']['URL'].startswith('https://www.zotero.org/download/client/update/')
    with zipfile.ZipFile(app / 'omni.ja') as archive:
        text = lambda file: archive.read(file).decode()
        runtime = text('resource/config.mjs')
        assert f"CLIENT_NAME: '{name}'" in runtime
        assert 'Zotero.Error.prototype.name = "Zotero Error"' in text('chrome/content/zotero/xpcom/error.js')
        for key, value in config['runtimeIdentity'].items():
            assert f"{key}: '{value}'" in runtime, f'Packaged identity changed: {key}'
        brand = text('chrome/en-US/locale/branding/brand.properties')
        assert f'brandFullName={name}' in brand
        prefs = text('defaults/preferences/zotero.js')
        assert re.search(r'pref\("app.update.auto",\s*false\)', prefs), 'Upstream automatic updates enabled'
        for file in archive.namelist():
            if file.endswith('/branding/brand.ftl'):
                assert f'-brand-full-name = {name}' in text(file), file
            if file.startswith(('resource/reader/', 'resource/note-editor/')) and file.endswith('.html'):
                assert not re.search(r'<title>[^<]*Zotero', text(file)), file
        for file, sha in approved.items():
            if file.startswith('chrome/skin/'):
                assert hashlib.sha256(archive.read(file)).hexdigest() == sha, f'Unapproved packaged artwork: {file}'
        full = text('chrome/skin/default/zotero/zotero.svg')
        image = base64.b64decode(re.search(r'base64,([^"]+)', full).group(1))
        assert image == (root / 'epilib-icons/full-transparent.png').read_bytes()
    if mac:
        info = plistlib.loads((bundle / 'Contents/Info.plist').read_bytes())
        assert info['CFBundleDisplayName'] == name
        icon = resources / info['CFBundleIconFile']
        assert hashlib.sha256(icon.read_bytes()).hexdigest() == approved['app/mac/Contents/Resources/epilib.icns']
    else:
        assert f'Name={name}' in (bundle / 'zotero.desktop').read_text()
        assert hashlib.sha256((bundle / 'icons/icon128.png').read_bytes()).hexdigest() == approved['app/linux/icons/icon128.png']
    print(f'Finished package passed branding, artwork, update and runtime-identity checks: {bundle}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('bundle', type=Path)
    check(parser.parse_args().bundle)
