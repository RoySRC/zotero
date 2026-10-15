import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("branding", HERE / "rebrand-integrations.py")
branding = importlib.util.module_from_spec(spec)
spec.loader.exec_module(branding)


class IntegrationBrandingTests(unittest.TestCase):
    def test_package_rebrand_retains_macros_and_identifiers(self):
        modules = branding.ROOT / "app/modules"
        for folder, filename in (
            ("zotero-word-for-mac-integration", "Zotero.dotm"),
            ("zotero-word-for-windows-integration", "Zotero.dotm"),
            ("zotero-libreoffice-integration", "Zotero_LibreOffice_Integration.oxt"),
        ):
            with self.subTest(folder=folder), tempfile.TemporaryDirectory() as temp:
                source = modules / folder / "install" / filename
                target = Path(temp) / filename
                shutil.copyfile(source, target)
                branding.rebrand_archive(target)
                with zipfile.ZipFile(source) as original, zipfile.ZipFile(target) as result:
                    self.assertEqual(original.namelist(), result.namelist())
                    changed = []
                    for name in original.namelist():
                        before, after = original.read(name), result.read(name)
                        if before == after:
                            continue
                        changed.append(name)
                        if name.endswith(".png"):
                            self.assertTrue(name.startswith("customUI/images/zotero"))
                            continue
                        self.assertTrue(name in ("customUI/customUI.xml", "description.xml") or name.endswith(".xcu"))
                        a, b = ET.fromstring(before), ET.fromstring(after)
                        # All IDs, callbacks, links and service attributes must survive.
                        def attributes(root):
                            return [{k: v for k, v in node.attrib.items() if k not in ("label", "getLabel", "supertip")}
                                    for node in root.iter()]
                        self.assertEqual(attributes(a), attributes(b))
                        self.assertIn(b"EpiLib", after)
                        if name.endswith(".xcu"):
                            self.assertIn(b'xmlns:xs="http://www.w3.org/2001/XMLSchema"', after)
                            self.assertEqual([n.text for n in a.iter("value") if n.text != "Zotero"],
                                             [n.text for n in b.iter("value") if n.text != "EpiLib"])
                    self.assertTrue(changed)
                # Rebuilding from an already-branded package should also work.
                branding.rebrand_archive(target)


if __name__ == "__main__":
    unittest.main()
