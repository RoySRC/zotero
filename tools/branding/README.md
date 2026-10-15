# EpiLib Branding and Compatibility

EpiLib is an independent fork, not an official Zotero product. The name change
does not confer trademark clearance or change upstream licenses. Copyright,
license and third-party attribution notices remain in place.

## Scope

- Desktop application names, menus, localized resources (including reader and
  note editor strings), About dialog, app icons and installer branding.
- PostgreSQL server display/log text; its API and database remain compatible.
- iOS and Android display names, localized resources, launch/login graphics,
  app icons and share illustrations in the sibling repositories.
- Chrome/Edge, Firefox and Safari connectors, localized messages, toolbar icons
  and the bundled Google Docs menu. Native Safari host names are also updated.
- Bundled Word ribbon and LibreOffice toolbar/package display labels are changed
  while packaging, without editing macros, callbacks or document field codes.

## Deliberately Retained

URLs (including update URLs), email addresses, HTTP headers, OAuth configuration,
bundle IDs, extension IDs, signing identities, URL schemes, command names,
JavaScript namespaces, resource keys, WebDAV paths, filenames, database names,
login-manager realms, preference keys and existing profile/data directory paths
are not product display labels. Renaming them could break existing installations.
`application.ini` keeps its Mozilla Name/Vendor/ID for profile compatibility.
`CLIENT_NAME` is now separate from `DATA_DIRECTORY_NAME`.

References to actual external services such as Zotero Storage, zotero.org
accounts, upstream documentation, the Zotero RDF format and upstream credits
retain their correct names. Mobile backend behavior is unchanged by this rebrand.

The macOS build creates `app/staging/EpiLib.app` and a `Zotero.app` symlink in the
same staging directory for existing development launchers. The executable remains
`Contents/MacOS/zotero`. Renaming does not isolate an installation's profile;
continue using the custom launcher or explicit `-profile` and `-datadir` options.
Automatic application updates default to off: the retained upstream update URL
is not an EpiLib release feed. Existing user preferences are not overwritten.

## Verification

From this repository:

```sh
node --test tools/branding/branding.test.mjs
python3 tools/branding/test_integrations.py
node tools/branding/check-workspace.mjs
node js-build/build.js
app/scripts/dir_build -p m -f
```

The workspace check compares changed files against each repository's HEAD,
checking URLs, resource keys, attribution, Fluent/JS/JSON syntax, Apple plists
and Android XML. Run it before committing the migration. Native mobile and Safari
builds require their platform SDKs, signing credentials and existing dependencies.

`generate-assets.mjs` renders the original EpiLib SVG sources into the existing
platform asset paths; it requires librsvg and macOS iconutil. The two
`rebrand-*.mjs` migration scripts apply reviewed display-value transformations to
the sibling source repositories. They are not application runtime dependencies.
