"""Disable native binary updates in each assembled Gecko runtime before signing.

Changing app.update.auto is insufficient: manual checks and previously queued
downloads can still run. Patch the service gate and download entry point, and
omit the updater executable. This never reads or deletes user update/profile data.
Exact anchors fail closed when an upstream runtime needs a new reviewed patch.
"""
import argparse
from pathlib import Path
import os
import shutil
import tempfile
import zipfile

PATCHES = {
    'modules/UpdateServiceStub.sys.mjs': (
        '  get updateDisabled() {\n',
        '    return true; // EPILIB_NATIVE_UPDATES_DISABLED\n'),
    'modules/UpdateService.sys.mjs': (
        '  async #downloadUpdate(update) {\n',
        '    throw new Error("EPILIB_NATIVE_UPDATES_DISABLED");\n'),
}


def patch_source(source, anchor, guard):
    """Idempotently insert one unconditional guard; never guess at a changed API."""
    if source.count(anchor) != 1:
        raise ValueError('Gecko updater changed; review EpiLib update isolation before building')
    if anchor + guard in source:
        return source
    return source.replace(anchor, anchor + guard, 1)


def harden(bundle):
    """Modify only the staging bundle; replace its archive atomically on success."""
    resources = bundle / 'Contents/Resources' if bundle.suffix == '.app' else bundle
    archive = resources / 'omni.ja'
    with zipfile.ZipFile(archive) as source:
        patched = {}
        for name, (anchor, guard) in PATCHES.items():
            patched[name] = patch_source(source.read(name).decode(), anchor, guard).encode()
        # Gecko accepts ordinary ZIPs as omni.ja; recompression preserves entries
        # and drops only the obsolete optimization index from the original archive.
        fd, temporary = tempfile.mkstemp(dir=resources, suffix='.ja')
        os.close(fd)
        try:
            with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as target:
                for entry in source.infolist():
                    target.writestr(entry, patched.get(entry.filename, source.read(entry.filename)))
            os.chmod(temporary, archive.stat().st_mode)
            os.replace(temporary, archive)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    # Excluding the executables also prevents the native startup path from
    # applying an old MAR before JavaScript services have initialized.
    for path in [bundle / 'Contents/MacOS/updater.app', resources / 'updater',
                 resources / 'updater.exe', resources / 'updater.ini']:
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    harden(parser.parse_args().bundle)
