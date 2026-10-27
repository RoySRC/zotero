"""Verify the finished desktop bundle, not just the source/build directory."""
import argparse
import base64
import configparser
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import plistlib
import re
import xml.etree.ElementTree as ET
import zipfile


class MenuItems(HTMLParser):
    """Read XUL menu classes without resolving the document's external DTD."""
    def __init__(self, markup):
        super().__init__()
        self.classes = []
        self.feed(markup)

    def handle_starttag(self, tag, attrs):
        if tag == 'menuitem':
            self.classes.append(set(dict(attrs).get('class', '').split()))


def check_menu_icons(archive):
    """Check shipped markup, compiled platform CSS and SVGs as one contract.

    The native tests exercise actual style resolution. This independent package
    gate catches stale CSS and omitted assets even when source tests are green.
    """
    menus = MenuItems(archive.read('chrome/content/zotero/zoteroPane.xhtml').decode())
    for action, icon in [('refresh-metadata', 'refresh'), ('refresh-publication', 'retrieve-metadata')]:
        selector = f'zotero-menuitem-{action}'
        assert any({selector, 'menuitem-iconic'} <= classes for classes in menus.classes), f'{action}: missing iconic menu entry'
        url = f'chrome://zotero/skin/16/universal/{icon}.svg'
        for platform in ['mac', 'win', 'unix']:
            css = archive.read(f'chrome/content/zotero-platform/{platform}/zotero.css').decode()
            # Inspect exact compiled rules, not source map strings or another
            # selector's declarations. Native tests cover cascade and themes.
            rules = ';'.join(re.findall(r'\.' + re.escape(selector) + r'\s*\{([^{}]*)\}', css))
            for prop in ['list-style-image', '--menuitem-icon']:
                pattern = r'(?:^|;)\s*' + re.escape(prop) + r'\s*:\s*url\([\"\x27]?' + re.escape(url) + r'[\"\x27]?\)\s*(?:;|$)'
                assert re.search(pattern, rules), f'{action}/{platform}: missing {prop} icon mapping'
            assert re.search(r'(?:^|;)\s*fill\s*:\s*var\(--fill-secondary\)', rules), f'{action}/{platform}: nonstandard icon color'
        path = f'chrome/skin/default/zotero/16/universal/{icon}.svg'
        assert path in archive.namelist(), f'{action}: missing SVG asset'
        svg = ET.fromstring(archive.read(path))
        assert svg.get('width') == '16' and svg.get('height') == '16', f'{action}: incorrect icon size'
        paths = list(svg.iter('{http://www.w3.org/2000/svg}path'))
        assert any(p.get('d') and p.get('fill') == 'context-fill' for p in paths), f'{action}: missing theme-aware artwork'


def check_runtime_identity(resources, config, mac_info=None):
    """Validate the identities that control profile, library and OS isolation.

    Read the finished files rather than source defaults: a correct source tree
    can still produce a stale application.ini or config module. Kept separate
    so regression tests can inject broken packages without copying a full app.
    Protocol IDs deliberately retain their compatibility values.
    """
    ini = configparser.ConfigParser(interpolation=None)
    ini.read(resources / 'app/application.ini')
    for key, value in {'Name': config['productName'], 'Vendor': config['productName'],
                       'ID': config['runtimeIdentity']['GUID']}.items():
        assert ini['App'][key] == value, f'Runtime identity changed: {key}'
    with zipfile.ZipFile(resources / 'app/omni.ja') as archive:
        runtime = archive.read('resource/config.mjs').decode()
        for key, value in config['runtimeIdentity'].items():
            assert f"{key}: '{value}'" in runtime, f'Packaged identity changed: {key}'
    if mac_info is not None:
        allowed = [config['runtimeIdentity']['BUNDLE_ID'] + suffix
                   for suffix in ['', '-source', '-dev', '-beta']]
        assert mac_info['CFBundleIdentifier'] in allowed, 'Shared macOS application identity'


def check(bundle):
    root = Path(__file__).resolve().parents[2]
    config = json.loads((root / 'tools/branding/config.json').read_text())
    approved = json.loads((root / 'tools/branding/approved-assets.json').read_text())
    name = config['productName']
    mac = bundle.suffix == '.app'
    resources = bundle / 'Contents/Resources' if mac else bundle
    app = resources / 'app'
    info = plistlib.loads((bundle / 'Contents/Info.plist').read_bytes()) if mac else None
    check_runtime_identity(resources, config, info)
    ini = configparser.ConfigParser(interpolation=None)
    ini.read(app / 'application.ini')
    assert ini['AppUpdate']['URL'] == '', 'Native binary update feed must be empty'
    with zipfile.ZipFile(resources / 'omni.ja') as runtime_archive:
        for module, guard in {
            'UpdateServiceStub': 'return true; // EPILIB_NATIVE_UPDATES_DISABLED',
            'UpdateService': 'throw new Error("EPILIB_NATIVE_UPDATES_DISABLED");',
        }.items():
            assert guard in runtime_archive.read(f'modules/{module}.sys.mjs').decode(), module
    for path in [bundle / 'Contents/MacOS/updater.app', resources / 'updater.exe', resources / 'updater']:
        assert not path.exists(), f'Native binary updater must not be shipped: {path}'
    with zipfile.ZipFile(app / 'omni.ja') as archive:
        check_menu_icons(archive)
        text = lambda file: archive.read(file).decode()
        for locale in (root / 'app/assets/multilocale.txt').read_text().strip().split(','):
            assert f'-brand-full-name = {name}' in text(f'localization/{locale}/branding/brand.ftl'), locale
            assert f'localization/{locale}/devtools/client/toolbox.ftl' in archive.namelist(), locale
        for platform in ['mac', 'win', 'unix']:
            css = text(f'chrome/content/zotero-platform/{platform}/zotero.css')
            for icon in set(re.findall(r'chrome://zotero/skin/([^"\x27)\s]*/loading\.svg)', css)):
                assert f'chrome/skin/default/zotero/{icon}' in archive.namelist(), icon
        runtime = text('resource/config.mjs')
        assert f"CLIENT_NAME: '{name}'" in runtime
        assert "REPOSITORY_URL: 'https://repo.zotero.org/repo/'" in runtime
        assert 'DOWNLOAD_URL: "https://epilib.org/downloads"' in runtime
        assert 'SUPPORT_URL: "https://epilib.org/"' in runtime
        assert 'EpiLib is running' in text('chrome/content/zotero/xpcom/server/server_connector.js')
        assert "formatValueSync('account-epilib-not-logged-in-text')" in text('chrome/content/zotero/xpcom/sync/syncRunner.js')
        assert 'epilib-org/epilib-desktop' in text('resource/epilibUpdates.mjs')
        stamp = json.loads(text('resource/epilib-release.json'))
        assert stamp['channel'] in ('stable', 'development')
        assert stamp['version'] is None if stamp['channel'] == 'development' else re.fullmatch(r'\d+\.\d+\.\d+', stamp['version'])
        assert 'Zotero.Error.prototype.name = "Zotero Error"' in text('chrome/content/zotero/xpcom/error.js')
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
        assert info['CFBundleDisplayName'] == name
        icon = resources / info['CFBundleIconFile']
        assert hashlib.sha256(icon.read_bytes()).hexdigest() == approved['app/mac/Contents/Resources/epilib.icns']
    elif (bundle / 'zotero.exe').exists():
        marker = configparser.ConfigParser()
        marker.read(bundle / 'epilib-install.ini')
        assert marker['Product']['InstallerIdentity'] == 'epilib-desktop', 'Missing Windows ownership marker'
    else:
        assert f'Name={name}' in (bundle / 'zotero.desktop').read_text()
        assert hashlib.sha256((bundle / 'icons/icon128.png').read_bytes()).hexdigest() == approved['app/linux/icons/icon128.png']
    print(f'Finished package passed branding, artwork, menu-icon, update and runtime-identity checks: {bundle}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('bundle', type=Path)
    check(parser.parse_args().bundle)
