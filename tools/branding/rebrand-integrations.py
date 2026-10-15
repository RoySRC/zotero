"""Brand copied Office packages; keep macros, callbacks, service IDs and URLs intact."""
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
import zipfile

OFFICE_UI = "http://schemas.microsoft.com/office/2006/01/customui"
OO_DESCRIPTION = "http://openoffice.org/extensions/description/2006"
OO_REGISTRY = "http://openoffice.org/2001/registry"
ROOT = Path(__file__).resolve().parents[2]


def branded_xml(name, data):
    root = ET.fromstring(data)
    changed = False
    if name == "customUI/customUI.xml":
        ET.register_namespace("", OFFICE_UI)
        for node in root.iter():
            if node.get("getLabel") == "ZoteroRibbon.ZoteroTabLabel":
                del node.attrib["getLabel"]
                node.set("label", "EpiLib")
                changed = True
            for attribute in ("label", "supertip"):
                value = node.get(attribute)
                if value and "Zotero" in value:
                    node.set(attribute, value.replace("Zotero", "EpiLib"))
                    changed = True
    elif name == "description.xml":
        ET.register_namespace("d", OO_DESCRIPTION)
        ET.register_namespace("xlink", "http://www.w3.org/1999/xlink")
        for node in root.findall(f"{{{OO_DESCRIPTION}}}display-name/{{{OO_DESCRIPTION}}}name"):
            node.text = node.text.replace("Zotero", "EpiLib")
            changed = True
    elif name.endswith(".xcu"):
        ET.register_namespace("oor", OO_REGISTRY)
        # xs:string occurs in attribute values, which ElementTree cannot infer as a QName.
        root.set("xmlns:xs", "http://www.w3.org/2001/XMLSchema")
        for prop in root.iter("prop"):
            if prop.get(f"{{{OO_REGISTRY}}}name") not in ("Title", "UIName"):
                continue
            for value in prop.findall("value"):
                if value.text == "Zotero":
                    value.text = "EpiLib"
                    changed = True
    return ET.tostring(root, encoding="utf-8", xml_declaration=True) if changed else data


def rebrand_archive(filename):
    replacement = filename.with_suffix(filename.suffix + ".epilib")
    try:
        with zipfile.ZipFile(filename) as archive, zipfile.ZipFile(replacement, "w") as output:
            output.comment = archive.comment
            if any(name.startswith("_xmlsignatures/") for name in archive.namelist()):
                raise ValueError(f"Refusing to modify a signed Office package: {filename}")
            for entry in archive.infolist():
                data = archive.read(entry)
                if entry.filename in ("customUI/customUI.xml", "description.xml") or entry.filename.endswith(".xcu"):
                    data = branded_xml(entry.filename, data)
                elif entry.filename in ("customUI/images/zoteroz16.png", "customUI/images/zotero-z-16.png"):
                    data = (ROOT / "chrome/skin/default/zotero/zotero-new-z-16px.png").read_bytes()
                output.writestr(entry, data)
        replacement.replace(filename)
    finally:
        replacement.unlink(missing_ok=True)


if __name__ == "__main__":
    folder = Path(sys.argv[1])
    for pattern in ("**/*.dotm", "**/*.oxt"):
        for archive in folder.glob(pattern):
            rebrand_archive(archive)
    for icon in folder.glob("**/zotero.png"):
        icon.write_bytes((ROOT / "app/linux/icons/icon128.png").read_bytes())
