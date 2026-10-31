#!/usr/bin/env bash
# Rebuild a native development app using the checkout containing this script.
# This wrapper does not install dependencies, fetch Git changes, start the app,
# or access user profiles. Run it after quitting EpiLib and preparing the normal
# desktop build dependencies (including the downloaded platform runtime).
set -euo pipefail

# Print help before probing dependencies so setup instructions remain available
# even on a machine that has no Node installation yet.
usage() {
	printf '%s\n' \
		'Usage: ./scripts/rebuild.sh [--help]' \
		'' \
		'Rebuild and validate EpiLib for this Mac or Linux machine.' \
		'Uses node/npm from PATH, or the configured NVM default if node is missing.' \
		'Requires installed npm dependencies, Python 3 and the platform build runtime.' \
		'Quit EpiLib before rebuilding. Profiles and library data are not changed.'
}

if [[ $# -gt 0 ]]; then
	if [[ $# -eq 1 && ( "$1" == '--help' || "$1" == '-h' ) ]]; then
		usage
		exit 0
	fi
	usage >&2
	exit 2
fi

# Never depend on the caller's current directory or a developer's home path.
# Clearing CDPATH prevents shell navigation preferences from contaminating the
# captured directory with extra output. Quoting preserves spaces in any path.
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"

# Match dir_build's native platform and staged directory names. These Linux
# names are compatibility paths, not user-visible branding. Windows packaging
# has a separate toolchain and is intentionally not offered by this wrapper.
case "$(uname -s)" in
	Darwin)
		platform=m
		bundle='app/staging/EpiLib.app'
		;;
	Linux)
		platform=l
		case "$(uname -m)" in
			x86_64) arch=x86_64 ;;
			arm64|aarch64) arch=arm64 ;;
			*) printf '%s\n' 'Unsupported Linux architecture.' >&2; exit 1 ;;
		esac
		bundle="app/staging/Zotero_linux-$arch"
		;;
	*) printf '%s\n' 'Unsupported host: this rebuild script supports macOS and Linux.' >&2; exit 1 ;;
esac

# Respect an already selected Node installation. For non-interactive shells
# where NVM has not been loaded, use its existing default alias, never a fixed
# version or an automatic download. NVM is third-party shell code, so suspend
# nounset while loading it; restore strict mode before our own build steps.
if ! command -v node >/dev/null 2>&1; then
	nvm_script="${NVM_DIR:-${HOME:-}/.nvm}/nvm.sh"
	if [[ -s "$nvm_script" ]]; then
		set +u
		if ! source "$nvm_script" --no-use || ! nvm use --silent default; then
			printf '%s\n' 'Could not load the NVM default. Select an installed Node version with nvm use, then retry.' >&2
			exit 1
		fi
		set -u
	fi
fi

# Fail before compiling if a required entry point is absent. Do not try to
# repair the developer's environment or change dependency versions implicitly.
for dependency in node npm python3; do
	if ! command -v "$dependency" >/dev/null 2>&1; then
		printf 'Missing %s on PATH. Install or activate it before rebuilding.\n' "$dependency" >&2
		exit 1
	fi
done
if [[ ! -d node_modules ]]; then
	printf '%s\n' 'Missing desktop dependencies. Run npm ci in the desktop checkout, then retry.' >&2
	exit 1
fi

# Browserify needs legacy OpenSSL support on current Node. Preserve any caller
# options, and do not duplicate the flag when it is already present. Explicitly
# disable the native test harness even if a previous test run exported it.
case " ${NODE_OPTIONS:-} " in
	*' --openssl-legacy-provider '*) ;;
	*) export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--openssl-legacy-provider" ;;
esac
export ZOTERO_TEST=0

# npm's existing build hook bundles the separate recognition engine (and honors
# EPILIB_RECOGNITION_SOURCE). Reuse it instead of maintaining a second bundler.
# set -e stops at the first failure and preserves that command's exit status,
# so a failed compilation cannot be followed by packaging stale output.
printf 'Building EpiLib in %s\nNode: %s\n' "$ROOT_DIR" "$(command -v node)"
npm run build
app/scripts/dir_build -p "$platform" -f
python3 tools/branding/check-package.py "$bundle"
printf '\nRebuild complete: %s/%s\n' "$ROOT_DIR" "$bundle"
