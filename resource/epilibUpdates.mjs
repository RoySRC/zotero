/**
 * Shared desktop/release-tool contract. URLs are constructed locally: feed data
 * cannot send users to an upstream binary or an unrelated executable.
 */
export const REPOSITORY = 'epilib-org/epilib-desktop';
export const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
export const FEED_URL = `${RELEASES_URL}/latest/download/epilib-update.json`;
export const PLATFORMS = Object.freeze({
	'mac-universal': 'zip',
	'linux-x64': 'tar.xz',
	'linux-arm64': 'tar.xz',
	'windows-x64': 'zip',
	'windows-arm64': 'zip'
});

/** Exclude prereleases, build IDs, unsafe numbers and arbitrary tag text. */
export function parseVersion(version) {
	if (typeof version !== 'string' || version !== version.trim()
		|| !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
		throw new Error('Expected a stable EpiLib version (major.minor.patch)');
	}
	let parts = version.split('.').map(Number);
	if (!parts.every(Number.isSafeInteger)) throw new Error('EpiLib version is out of range');
	return parts;
}

/** Numeric comparison avoids treating 1.10.0 as older than 1.9.0. */
export function compareVersions(left, right) {
	let a = parseVersion(left);
	let b = parseVersion(right);
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
	}
	return 0;
}

/** Return the only allowed artifact name for a version/platform combination. */
export function assetName(version, platform) {
	parseVersion(version);
	if (!Object.hasOwn(PLATFORMS, platform)) throw new Error('Unsupported EpiLib platform');
	return `EpiLib-${version}-${platform}.${PLATFORMS[platform]}`;
}

/** Reject invalid or incomplete feed data before presenting an update. */
export function validateFeed(feed) {
	if (!feed || feed.schemaVersion !== 1 || feed.repository !== REPOSITORY || feed.channel !== 'stable') {
		throw new Error('Not an EpiLib stable update feed');
	}
	parseVersion(feed.version);
	if (feed.tag !== `epilib-v${feed.version}` || !/^[a-f0-9]{40}$/.test(feed.commit || '')) {
		throw new Error('Invalid EpiLib release identity');
	}
	let platforms = Object.keys(PLATFORMS);
	if (!Array.isArray(feed.assets) || feed.assets.length !== platforms.length) {
		throw new Error('Incomplete EpiLib release');
	}
	for (let platform of platforms) {
		let assets = feed.assets.filter(asset => asset?.platform === platform);
		if (assets.length !== 1 || assets[0].name !== assetName(feed.version, platform)
			|| !/^[a-f0-9]{64}$/.test(assets[0].sha256 || '')
			|| !Number.isSafeInteger(assets[0].size) || assets[0].size <= 0) {
			throw new Error(`Invalid EpiLib artifact: ${platform}`);
		}
	}
	return feed;
}

/** Release pages, not remote-supplied URLs, are the installation entry point. */
export function releaseURL(version) {
	parseVersion(version);
	return `${RELEASES_URL}/tag/epilib-v${version}`;
}
