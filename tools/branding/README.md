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

Service URLs (except the intentionally replaced desktop binary update feed), email addresses, HTTP headers, OAuth configuration,
extension IDs, URL schemes, command names,
JavaScript namespaces, resource keys, WebDAV paths, filenames, database names,
login-manager realms and preference keys
are not product display labels. Renaming them could break existing installations.
The internal `Zotero Error` name is also preserved: sync uses it for error dispatch.
`application.ini` uses EpiLib for Name/Vendor so normal launches select independent
profiles and caches. Its application ID remains compatible with existing extensions;
that ID is not the profile-directory name. The macOS bundle identifier is
`org.epilib.epilib` (with a build-channel suffix for development/beta builds).

References to actual external services such as Zotero Storage, zotero.org
accounts, upstream documentation, the Zotero RDF format and upstream credits
retain their correct names. Mobile backend behavior is unchanged by this rebrand.

The macOS build creates `app/staging/EpiLib.app` and a `Zotero.app` symlink in the
same staging directory for existing development launchers. The executable remains
`Contents/MacOS/zotero` for existing launchers. Normal launches now use independent
EpiLib profile and data directories; no custom launcher is required for isolation.
Explicit `-profile` and `-datadir` arguments still override the defaults. An old
launcher with explicit Zotero paths will therefore keep using those paths.

### Fresh Profiles and Data

EpiLib does not automatically copy, migrate, or open official Zotero's profiles or
libraries. A fresh installation starts logged out; saved account tokens and API
keys in another profile are not imported. Existing directories remain untouched.
On macOS, the defaults are `~/Library/Application Support/EpiLib/Profiles/`,
`~/Library/Caches/EpiLib/`, and `~/EpiLib/` for the library and attachment storage.
On Windows and Linux, Gecko derives the profile roots from the EpiLib Name/Vendor.
The library defaults to `EpiLib` in the user's home directory on all platforms.
The internal database filename stays `zotero.sqlite` for schema/tool compatibility;
it lives inside the isolated EpiLib directory, not the official Zotero library.
Native Zotero binary updates are disabled in assembled runtimes and their updater
executables are omitted. EpiLib release notifications use GitHub Releases; see
`tools/updates/README.md`. Translator/style repository updates and existing user
preferences remain independent.

## Product Links and Windows Isolation

Public onboarding, help, feedback and new-feature links now use `https://epilib.org/`.
Architecture warnings and connector downloads use `https://epilib.org/downloads`.
These are intentional product-navigation changes, not a rewrite of service APIs.
The home page is a placeholder until dedicated documentation/forum routes exist.
Explicit upstream credits, licensing and the upstream changelog remain upstream.
Error/debug report submission is deferred and still uses the Zotero report service.

Windows installers use `Software\EpiLib`, EpiLib uninstall entries/ProgIDs and an
`EpiLib.exe` App Paths alias pointing to the retained `zotero.exe` executable.
`epilib-install.ini` marks EpiLib packages independently of Mozilla's app ID.
Setup accepts an empty directory or a marked EpiLib installation, never an
unmarked official installation. Older unmarked custom builds require a separate
install directory; no installer attempts to adopt or uninstall them automatically.
The uninstaller preserves all profiles, credentials, shared update caches and
unlogged files. Existing file/protocol defaults belonging to other apps are not
overwritten. The compatible `zotero://` scheme is registered only if unclaimed
or already owned by that installation. Opening old links still uses the current
OS-selected handler; users can choose the app through Windows default-app settings.

Installation/removal and default runtime profiles are isolated. The connector
port and document identifiers remain compatible, so simultaneous connector access
is still a separate concern from profile and data-directory isolation.

Run `node --test tools/branding/windows-installer.test.mjs` on any host. On
Windows, `tools/branding/test-windows-isolation.ps1` compiles the production NSIS
ownership guards and executes them against missing/empty, official, wrong-marker,
EpiLib, profile and library fixtures. It never touches real installed apps or the
registry. This test also runs as the Windows job in the branding/release gate.
Full interactive installer/upgrade/uninstaller behavior still needs a Windows VM
smoke test before distributing an installer; archive packaging alone does not
exercise Windows registration or UAC.

## Verification

From this repository:

```sh
node --test tools/branding/branding.test.mjs
node --test tools/branding/assets.test.mjs
python3 tools/branding/test_integrations.py
node tools/branding/check-workspace.mjs
node js-build/build.js
app/scripts/dir_build -p m -f
```

The workspace check compares changed files against each repository's HEAD,
checking URLs, resource keys, attribution, Fluent/JS/JSON syntax, Apple plists
and Android XML. Run it before committing the migration. Native mobile and Safari
builds require their platform SDKs, signing credentials and existing dependencies.

`generate-assets.mjs` renders the supplied PNGs in `epilib-icons/` into platform
assets; it requires librsvg and macOS iconutil. `compact.png` is the general logo,
`full-transparent.png` is used for full-logo placements, and `macos-compact.png` supplies the
macOS app icon and Safari host icons. The originals are never edited. Transparent
outer padding is excluded using the reviewed bounds in `assets.mjs`, and artwork
is fitted without stretching or recoloring. The original `full.png` is retained;
its white backdrop is removed in the separate `full-transparent.png` derivative.
`remove-full-background.mjs` regenerates that derivative using the optional
`sharp` package and the reviewed page-protection mask in `full-logo-pages.svg`.
It checks transparent background/counter pixels and unchanged foreground samples.
The compact and macOS artwork retain their supplied backgrounds.
The Android adaptive icon uses the supplied color artwork; no separate themed
monochrome icon is supplied. Apple asset catalogs use native PNGs, while desktop
SVG resource paths embed the PNG so existing consumers continue to work.
The two
`rebrand-*.mjs` migration scripts apply reviewed display-value transformations to
the sibling source repositories. They are not application runtime dependencies.

## Automated Upstream Integration

`.github/workflows/epilib-upstream.yml` integrates **zotero/zotero main** into
**epilib-org/epilib-desktop rebranding** every Monday at 09:17 UTC. It also supports a manual
run, with **dry run enabled by default**. This is desktop/server automation;
mobile and connector repositories still use the workspace migration tools and
need their own platform CI before release. It does not update a release branch.

The workflow:

1. Fetches the target and upstream histories into a clean, detached checkout.
2. Attempts a normal two-parent merge. Conflicts abort without changing GitHub.
   No `ours`/`theirs` strategy, rebases, resets of user work, or force pushes.
3. Applies reviewed locale/display-label overrides and restores only explicitly
   approved logo assets from the target snapshot. Functional upstream changes
   are kept. Unexpected changes to integration policy require manual review.
4. Fails on new, unreviewed Zotero references or artwork, missing installer/build
   branding, profile-identity changes, or an enabled upstream automatic updater.
5. Commits the candidate locally and runs the branding tests, Office-package
   tests, PostgreSQL authentication/metadata regressions, and the real desktop
   UI, Account, metadata-sync and WebDAV suites. Tests use an isolated PostgreSQL
   service and a temporary desktop test profile, never production credentials.
6. Builds a non-test Linux package and inspects its actual `omni.ja`, localized
   branding, bundled reader/editor titles, artwork, update defaults, and runtime
   identities. `check-package.py` also supports local macOS bundles. Windows
   installer source is guarded; this workflow does not build/sign Windows,
   macOS, mobile or connector releases.
7. Exports the exact tested Git commit as a bundle. A separate write-privileged
   job imports Git objects only, verifies both parents and the candidate SHA,
   checks that `rebranding` has not moved, and performs a normal fast-forward push.
   It never executes candidate scripts with the write token. A race or branch
   protection rejection stops the update; rerun against the new branch head.

All third-party Actions in these workflows are pinned to reviewed commit SHAs.
Tests/builds run with read-only permissions and no production secrets. A failed
job stays failed: the workflow does not weaken tests to force an upstream merge.
The existing full upstream CI remains available as additional release coverage.

### Activation

- Commit the branding tools, workflows, `epilib-icons/` source PNGs and generated
  assets together on `rebranding`. The artwork from the local icon work must be
  included: CI deliberately rejects missing/unapproved image data.
- Install `epilib-upstream.yml` on the repository's **default branch as well**.
  GitHub schedules run only from that branch; the job itself checks out
  `rebranding`. There is no need to change the default branch.
- Enable Actions on the fork. Permit the publish job's `GITHUB_TOKEN` to write
  contents under your repository policy. No personal access token is needed.
  Branch rules are respected, never bypassed. If direct bot updates are forbidden,
  keep dry-run mode and integrate the validated candidate through your review flow.
- First run **EpiLib Upstream Integration** manually with dry run selected, inspect
  its logs/artifact, then run with dry run off or let the weekly schedule publish.
- Require **EpiLib Branding Gate / branding** (use the exact check name shown by
  GitHub) and the normal application CI checks in release-branch protection.
  `epilib-branding.yml` runs on all PRs and on pushes to `rebranding`. No automated
  release merge is configured. Pushes made by `GITHUB_TOKEN` do not trigger a new
  push workflow, so the upstream integration job runs all mandatory gates itself.

GitHub documentation: [scheduled events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
and [token-triggered workflows](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

### Policy and Local Checks

`config.json` centralizes the display name, target/upstream description, reviewed
literal overrides, external-service/URL allowlist, resource exceptions, and
compatibility assertions. `js-build/branding.js` also uses this configuration for
downloaded reader/editor bundle titles. Runtime identifiers remain unchanged.
The workflow's fetch/push destination is deliberately explicit; changing it
requires reviewing both configuration and workflow. New reference exceptions
must specify an exact `file`, exact string `value`, and a `reason` in
`referenceExceptions`. Do not add a blanket file or word exemption.

`approved-assets.json` records SHA-256 hashes of reviewed desktop artwork. It is
not automatically refreshed during upstream integration. After intentionally
changing artwork, regenerate with `generate-assets.mjs`, visually review it, and
update the affected hashes in the same change. This prevents an upstream logo
from being accepted simply because it was present in a new build.

The new standalone commands do not require sibling repositories:

```sh
node tools/branding/apply.mjs --check
node tools/branding/check-upstream.mjs --base <previous-rebranding-commit>
node --test tools/branding/*.test.mjs
python3 tools/branding/test_integrations.py
python3 tools/branding/check-package.py app/staging/EpiLib.app
```

Both metadata menu actions have independent visual regression coverage:

```sh
python3 tools/branding/test_menu_icons.py
test/runtests.sh -f -b metadataMenuIcons recognitionEngine recognitionReview
```

The Python suite compiles the real macOS, Windows, and Linux Sass and checks an
in-memory package. It deliberately removes each action's icon mapping, native
or in-content CSS property, iconic menu class, and SVG asset, and also rejects
blank, oversized, or hardcoded-color artwork. These mutations never alter source
files. The release package checker applies the same checks to the finished app.

The six native integration cases open the actual item popup in light and dark
themes, verify resolved styles against a neighboring command, and decode the
shipped 16-pixel SVGs. They cover both Refresh Metadata and Update to Published
Version on preprints, plus Refresh Metadata on DOI-less published items. These
tests use the runner's disposable profile, not the user's library. Both branding
and upstream-integration workflows require these suites.

Profile and library isolation has three complementary test layers:

```sh
node --test tools/branding/profile-isolation.test.mjs tools/branding/scratch-isolation.test.mjs
python3 tools/branding/test_profile_package.py
CI=1 test/runtests.sh -f -b epilibProfileIsolation epilibBranding dataDirectory profile
```

The Node tests execute the production directory selector and profile discovery
against disposable homes. They cover fresh startup, restart, explicit-path
precedence, missing/invalid paths, multiple profiles, profile-local libraries,
database/backup/supporting paths, and preservation of old credentials and PDFs.
Scratch tests execute the real creation and shutdown callbacks for simulated
macOS, Windows and Linux paths, including the system-temp fallback.

The native integration suite uses Gecko file APIs and real SQLite databases,
reopens a library after reloading the startup modules, and imports a real PDF
through the attachment API in the test runner's disposable library. Production
profiles, account tokens and OS-keychain entries are never read or changed.
The package tests deliberately introduce old Name/Vendor, data-directory and
bundle identities, and incompatible internal IDs, ensuring the release gate
rejects each regression. All three layers run in the branding gate inherited by
the upstream integration workflow. Platform simulations are not a substitute
for native Windows/Linux release smoke tests.

`apply.mjs` without `--check` writes the reviewed overlay. `--base <commit>` may
restore approved artwork from that target commit. Neither command merges or
pushes. `merge-upstream.mjs` refuses dirty or attached checkouts; use it only in
the disposable integration checkout established by the workflow. An unchanged
upstream is a no-op, and conflicts require a separate manual resolution/review.

Known limits: string scanning is a regression detector, not a trademark/legal
audit. It inspects new string values and changed declarative UI relative to the
target snapshot, preserving established compatibility references. Novel UI
surfaces and artwork still require human review. Current validation does not
claim native-mobile, Windows-package, or signed-distribution test coverage.
