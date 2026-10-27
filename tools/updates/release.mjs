/**
 * EpiLib release assembly. No Zotero deploy scripts, S3 credentials or upstream
 * release endpoints are used. Artifacts are immutable and the manifest is emitted
 * only when every supported platform is present. CLI actions are also testable
 * functions; importing this module never builds or publishes anything.
 */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPOSITORY, PLATFORMS, assetName, parseVersion, validateFeed, compareVersions }
	from '../../resource/epilibUpdates.mjs';

const root = path.resolve(import.meta.dirname, '../..');

/** Hash in a stream so multi-hundred-megabyte archives don't exhaust CI memory. */
export async function digest(file) {
	let hash = createHash('sha256');
	for await (let chunk of createReadStream(file)) hash.update(chunk);
	return hash.digest('hex');
}

/** Build a complete manifest from actual artifacts, not caller-supplied hashes. */
export async function manifest(directory, version, commit) {
	parseVersion(version);
	let assets = [];
	for (let platform of Object.keys(PLATFORMS)) {
		let name = assetName(version, platform);
		let file = path.join(directory, name);
		let stat = await fs.lstat(file);
		if (!stat.isFile()) throw new Error(`Not a regular release artifact: ${name}`);
		assets.push({ platform, name, size: stat.size, sha256: await digest(file) });
	}
	return validateFeed({ schemaVersion: 1, repository: REPOSITORY, channel: 'stable',
		version, tag: `epilib-v${version}`, commit, assets });
}

/** Detect artifact replacement/truncation between assembly and publication. */
export async function verify(directory, feed) {
	validateFeed(feed);
	let actual = await manifest(directory, feed.version, feed.commit);
	for (let asset of actual.assets) {
		let expected = feed.assets.find(entry => entry.platform === asset.platform);
		if (asset.size !== expected.size || asset.sha256 !== expected.sha256) {
			throw new Error(`Release artifact changed: ${asset.name}`);
		}
	}
}

/**
 * Refuse a backwards "latest" release or an unexpected repository history.
 * Only 404 means no release exists; auth/rate-limit/network failures abort.
 * Tokens go solely to the fixed GitHub API origin, never to release asset URLs.
 */
export async function preflight(version, token, request = fetch) {
	parseVersion(version);
	let response = await request(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
		redirect: 'error', signal: AbortSignal.timeout(20000),
		headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
			...(token ? { Authorization: `Bearer ${token}` } : {}) }
	});
	if (response.status === 404) return;
	if (!response.ok) throw new Error(`GitHub release preflight failed: ${response.status}`);
	let latest = await response.json();
	if (!latest.tag_name?.startsWith('epilib-v')
		|| compareVersions(version, latest.tag_name.slice(8)) <= 0) {
		throw new Error('Release must be newer than the latest published EpiLib release');
	}
}

/** Run an existing build tool without shell interpolation of tags or paths. */
function run(command, args, cwd = root) {
	execFileSync(command, args, { cwd, stdio: 'inherit' });
}

/**
 * Package an already compiled desktop checkout. Preserve the inherited runtime
 * version for compatibility; stamp EpiLib's independent release identity in the
 * prepared copy, never in the working tree. Staging is always rebuilt from scratch.
 * These are unsigned review artifacts until maintainers configure release signing.
 */
export async function build(version, platform, output) {
	let name = assetName(version, platform);
	let directory = await fs.mkdtemp(path.join(os.tmpdir(), 'epilib-release-'));
	let commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
	let definitions = {
		'mac-universal': ['m', null, 'EpiLib.app'],
		'linux-x64': ['l', 'x64', 'Zotero_linux-x86_64'],
		'linux-arm64': ['l', 'arm64', 'Zotero_linux-arm64'],
		'windows-x64': ['w', 'x64', 'Zotero_win-x64'],
		'windows-arm64': ['w', 'arm64', 'Zotero_win-arm64']
	};
	let [target, arch, bundleName] = definitions[platform];
	try {
		run('python3', ['app/scripts/prepare_build', '-s', 'build', '-o', directory, '-c', 'release']);
		await fs.writeFile(path.join(directory, 'resource/epilib-release.json'),
			JSON.stringify({ version, channel: 'stable', commit }, null, 2) + '\n');
		run('bash', ['app/build.sh', '-d', directory, '-p', target, '-c', 'release', '-s', '-q',
			...(arch ? ['-a', arch] : [])]);
		let bundle = path.join(root, 'app/staging', bundleName);
		if (target === 'm') run('bash', ['app/scripts/codesign_local', bundle]);
		run('python3', ['tools/branding/check-package.py', bundle]);
		await fs.mkdir(output, { recursive: true });
		let artifact = path.resolve(output, name);
		try {
			await fs.lstat(artifact);
			throw new Error(`Refusing to overwrite release artifact: ${artifact}`);
		}
		catch (error) { if (error.code !== 'ENOENT') throw error; }
		if (target === 'm') run('ditto', ['-c', '-k', '--keepParent', bundle, artifact]);
		else if (target === 'l') run('tar', ['-cJf', artifact, bundleName], path.dirname(bundle));
		else run('zip', ['-rqX', artifact, bundleName], path.dirname(bundle));
	}
	finally { await fs.rm(directory, { recursive: true, force: true }); }
}

/** CLI dispatch is explicit so an accidental argument cannot trigger publication. */
async function main([action, ...args]) {
	if (action === 'build' && args.length === 3) return build(...args);
	if (action === 'preflight' && args.length === 1) return preflight(args[0], process.env.GH_TOKEN);
	if (action === 'manifest' && args.length === 3) {
		let [directory, version, commit] = args;
		let feed = await manifest(directory, version, commit);
		await fs.writeFile(path.join(directory, 'epilib-update.json'), JSON.stringify(feed, null, 2) + '\n', { flag: 'wx' });
		await fs.writeFile(path.join(directory, 'SHA256SUMS'),
			feed.assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join(''), { flag: 'wx' });
		return;
	}
	if (action === 'verify' && args.length === 1) {
		return verify(args[0], JSON.parse(await fs.readFile(path.join(args[0], 'epilib-update.json'))));
	}
	throw new Error('Usage: release.mjs build VERSION PLATFORM OUTPUT | manifest DIR VERSION COMMIT | verify DIR | preflight VERSION');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	await main(process.argv.slice(2));
}
