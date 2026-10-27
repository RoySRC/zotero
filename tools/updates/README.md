# EpiLib Desktop Releases

## Two Independent Update Paths

- **Application binaries:** EpiLib checks `https://github.com/epilib-org/epilib-desktop/releases/latest/download/epilib-update.json`. Help > Check for Updates opens the EpiLib dialog. Stable builds check after two minutes, then at most daily, and notify once per newer version. The dialog opens the specific GitHub release page for **manual installation**. It never downloads, executes or replaces a binary itself.
- **Translators and styles:** the existing `https://repo.zotero.org/repo/` service, preference, notification handling and updater remain unchanged. Disabling EpiLib release notifications does not disable these updates.

There is no fallback to Zotero's binary feed. A 404, network failure or malformed manifest is reported as unavailable, not "up to date". The feed must be publicly readable; do not distribute private GitHub tokens to desktop clients. A missing public release is expected until the first release is published.

The bundled `resource/epilib-release.json` is the release identity. Source builds have `version: null` and never query automatically. Packaging stamps `version`, `channel: stable`, and the exact Git commit into the prepared copy. EpiLib uses independent three-part release versions and `epilib-vMAJOR.MINOR.PATCH` tags. The inherited Mozilla runtime version, Name/Vendor/ID, profile paths, data directories, extension IDs and account credentials are not changed. About shows the EpiLib version followed by the runtime version in parentheses.

## Native Updater Isolation

`app/assets/application.ini` has an empty native update URL. `tools/updates/harden-runtime.py` runs on every full macOS, Windows and Linux assembly, before signing or packaging. It disables Gecko's update service and download entry point unconditionally, even if an old profile has `app.update.auto=true` or an old wizard invokes a foreground check. Native updater executables are omitted as well, so the early native startup update path cannot use them. User profiles and caches are not deleted or migrated by this operation.

The runtime patch requires exactly one occurrence of each reviewed API entry point. An upstream Gecko change fails the build instead of silently omitting the guard. Package checks inspect the actual runtime archive and executable paths. Do not remove these checks to make an upstream merge pass. This protects **newly rebuilt/installed EpiLib copies**, not older app bundles that have not been replaced.

## GitHub Setup

1. Commit these changes, the existing branded assets, submodule references, and the bundled recognition artifact to `epilib-org/epilib-desktop`. Merge reviewed release changes into `main`, its current default branch. The separate upstream-integration workflow still requires a `rebranding` branch and does not promote changes to `main` automatically.
2. Enable Actions and allow the release job to use a contents-write `GITHUB_TOKEN`. The test/build jobs have read-only permissions, no account credentials, and disposable test databases.
3. Create an `epilib-release` environment with required reviewers and restrict it to approved release tags/branches. Protect `epilib-v*` tags from deletion or movement. Only trusted maintainers should change release workflows or tools.
4. Create an annotated tag, for example `epilib-v1.0.0`, on a reviewed commit reachable from `main`, and push that tag. This triggers validation, five platform archives, and a **draft** release. Nothing is advertised until publication.
5. Review the draft, add release-specific notes, and perform platform smoke/signing checks. Publish using GitHub's release editor and mark it latest. Alternatively dispatch **EpiLib Release** for a fresh existing tag with `publish=true`; after validation/environment approval, it uploads a draft first and only publishes after all uploads succeed.

The dispatch path does not overwrite existing drafts or releases. A partially uploaded draft stays private; inspect/delete only that incomplete draft before retrying. Do not move a published tag or replace its assets. Use a new patch version for fixes. The publication preflight refuses equal/older versions and treats API failures as failures. Configure GitHub immutable releases where available.

## What the Pipeline Produces

`epilib-release.yml` runs the branding/account/metadata/WebDAV/native UI gate on the exact tagged commit, builds macOS universal, Linux x64/arm64, and Windows x64/arm64 archives, checks the assembled packages, then generates:

- `epilib-update.json`: schema version, repository, stable version/tag/commit, and the exact platform filenames, byte sizes and SHA-256 hashes.
- `SHA256SUMS`: checksums of all five archives.

The feed cannot select arbitrary destinations: the client validates its identity/artifacts and constructs the release page URL itself. GitHub HTTPS and repository control are the trust boundary. Hashes detect corruption; they are **not independent signatures** if the GitHub account or release is compromised.

**Signing limitation:** this initial workflow produces unsigned review archives (macOS components receive the existing development ad-hoc signing). It does not claim Developer ID notarization, Authenticode signing, Windows installer support, or silent in-place updates. Native runtime tests run on Linux in CI; ARM and Windows packages need on-device smoke tests. Keep drafts unpublished for general distribution until signing and those checks are in place. The pipeline deliberately does not reuse Zotero's deployment/signing credentials. In-place installation would require a separate, EpiLib-owned signed-update design.

## Local Verification

```sh
node --test tools/updates/*.test.mjs tools/branding/*.test.mjs
python3 -m unittest discover -s tools/updates -p 'test_*.py'
npm run build
ZOTERO_TEST=1 app/scripts/dir_build -f
test/runtests.sh -f -b epilibUpdates epilibBranding epilibSyncIsolation
ZOTERO_TEST=0 app/scripts/dir_build -f
python3 tools/branding/check-package.py app/staging/EpiLib.app
```

Use the Linux staging path on Linux. The native suite verifies that both background and foreground Gecko checks are blocked and that a translator/style repository response still reaches the normal database update path. Node tests execute the actual desktop checker with service doubles and exercise invalid feeds, duplicate checks, timeout/error propagation, opt-out, version ordering, once-daily retries, source-build behavior and publication integrity. Python tests cover each platform's runtime hardening, upstream API changes and idempotence.

For an isolated package rehearsal after `npm run build`, run `node tools/updates/release.mjs build 1.0.0 mac-universal /path/to/empty-artifacts`. This changes the staging app, not your source version or profiles. Rebuild the development app afterward. Nothing in the build or manifest commands publishes to GitHub.
