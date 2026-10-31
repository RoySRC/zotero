'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.resolve(__dirname, '../../scripts/rebuild.sh');

/**
 * Run the production shell entry point in a disposable checkout. Only the
 * expensive build tools are replaced: their recorder captures arguments,
 * working directory and environment as JSON so assertions test actual shell
 * behavior, not just whether particular strings appear in the script.
 *
 * The isolated PATH deliberately excludes the developer's installed tools.
 * This makes missing-runtime and NVM tests reproducible on Macs and CI hosts
 * that already have Node installed. Every fixture also contains spaces in its
 * paths and an unrelated launch directory to catch missing shell quoting.
 */
function fixture(t, { missing = [], nvm = false } = {}) {
	// macOS exposes /var through a symlink; compare physical paths like pwd -P.
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'epilib rebuild test ')));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, 'desktop checkout');
	const bin = path.join(dir, 'active tools');
	const home = path.join(dir, 'user home');
	const cwd = path.join(dir, 'unrelated working directory');
	const log = path.join(dir, 'build.jsonl');
	for (const folder of [bin,
		home,
		cwd,
		path.join(root, 'scripts'),
		path.join(root, 'app/scripts'),
		path.join(root, 'node_modules'),
		path.join(root, 'tools/branding')]) {
		fs.mkdirSync(folder, { recursive: true });
	}
	fs.copyFileSync(script, path.join(root, 'scripts/rebuild.sh'));
	fs.chmodSync(path.join(root, 'scripts/rebuild.sh'), 0o755);
	fs.writeFileSync(path.join(root, 'package.json'), '{}');
	fs.writeFileSync(path.join(root, 'tools/branding/check-package.py'), '# fixture');
	const profile = path.join(home, 'profile-data');
	fs.writeFileSync(profile, 'existing profile and library');

	// The recorder uses the test runner's executable explicitly, not the fake
	// PATH. A missing Node installation can therefore still be tested reliably.
	const recorder = path.join(dir, 'record.cjs');
	fs.writeFileSync(recorder, `
const fs = require('node:fs');
const [stage, ...args] = process.argv.slice(2);
fs.appendFileSync(process.env.BUILD_LOG, JSON.stringify({
	stage, args, cwd: process.cwd(), test: process.env.ZOTERO_TEST,
	nodeOptions: process.env.NODE_OPTIONS, source: process.env.EPILIB_RECOGNITION_SOURCE
}) + '\\n');
process.exit(process.env.FAIL_STAGE === stage ? 37 : 0);
`);

	/** Write a tool double that logs one stage and propagates its exit status. */
	function tool(file, stage) {
		fs.writeFileSync(file, `#!/bin/bash\nexec "$TEST_NODE" "$RECORDER" '${stage}' "$@"\n`, { mode: 0o755 });
	}
	for (const toolName of ['node', 'npm', 'python3']) {
		if (!missing.includes(toolName)) tool(path.join(bin, toolName), toolName);
	}
	fs.symlinkSync('/usr/bin/dirname', path.join(bin, 'dirname'));
	fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/bash\nif [[ "$1" == "-m" ]]; then\n printf "%s\\n" "$TEST_ARCH"\nelse\n printf "%s\\n" "$TEST_OS"\nfi\n', { mode: 0o755 });
	tool(path.join(root, 'app/scripts/dir_build'), 'package');

	// The fallback models NVM's configured default, with no installed version
	// baked into the script. Loading it must never install a Node release.
	const nvmDir = path.join(dir, 'custom nvm');
	if (nvm) {
		const nvmBin = path.join(nvmDir, 'selected runtime');
		fs.mkdirSync(nvmBin, { recursive: true });
		tool(path.join(nvmBin, 'node'), 'node');
		tool(path.join(nvmBin, 'npm'), 'npm');
		fs.writeFileSync(path.join(nvmDir, 'nvm.sh'), `
[[ "$1" == "--no-use" ]] || return 90
nvm() {
	[[ "$*" == "use --silent default" ]] || return 91
	[[ "\${FAIL_NVM:-0}" == "0" ]] || return 92
	export PATH="$NVM_DIR/selected runtime:$PATH"
}
`);
	}
	const env = {
		PATH: bin, HOME: home, NVM_DIR: nvmDir, TEST_NODE: process.execPath,
		RECORDER: recorder, BUILD_LOG: log, TEST_OS: 'Darwin', TEST_ARCH: 'arm64',
		ZOTERO_TEST: '1', NODE_OPTIONS: '--trace-warnings',
		EPILIB_RECOGNITION_SOURCE: path.join(dir, 'separate engine')
	};
	return {
		root, bin, home, profile, env,
		run(args = [], overrides = {}) {
			return spawnSync('/bin/bash', [path.join(root, 'scripts/rebuild.sh'), ...args], {
				cwd, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000
			});
		},
		records() {
			return fs.existsSync(log)
				? fs.readFileSync(log, 'utf8').trim().split('\n')
.map(line => JSON.parse(line))
				: [];
		}
	};
}

test('rebuild works from another directory, preserves runtime options and builds a normal Mac app', (t) => {
	const f = fixture(t, { nvm: true });
	// An active runtime must win even if the user's NVM default is broken.
	const result = f.run([], { FAIL_NVM: '1' });
	assert.equal(result.status, 0, result.stderr);
	const records = f.records();
	assert.deepEqual(records.map(record => [record.stage, record.args]), [
		['npm', ['run', 'build']],
		['package', ['-p', 'm', '-f']],
		['python3', ['tools/branding/check-package.py', 'app/staging/EpiLib.app']]
	]);
	for (const record of records) {
		assert.equal(record.cwd, f.root);
		assert.equal(record.test, '0', 'Never ship the inherited test harness');
		assert.equal(record.nodeOptions, '--trace-warnings --openssl-legacy-provider');
		assert.equal(record.source, f.env.EPILIB_RECOGNITION_SOURCE);
	}
	assert.ok(result.stdout.includes(path.join(f.root, 'app/staging/EpiLib.app')));
	assert.equal(fs.readFileSync(f.profile, 'utf8'), 'existing profile and library');
});

test('rebuild can load the configured NVM default when Node is not on PATH', (t) => {
	const f = fixture(t, { missing: ['node', 'npm'], nvm: true });
	const result = f.run();
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(f.records().map(record => record.stage), ['npm', 'package', 'python3']);
});

test('NVM failure stops before touching the build', (t) => {
	const f = fixture(t, { missing: ['node', 'npm'], nvm: true });
	const result = f.run([], { FAIL_NVM: '1' });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /NVM.*default/i);
	assert.deepEqual(f.records(), []);
});

for (const dependency of ['node', 'npm', 'python3']) {
	test(`missing ${dependency} produces an actionable error before building`, (t) => {
		const f = fixture(t, { missing: [dependency] });
		const result = f.run();
		assert.notEqual(result.status, 0);
		assert.ok(result.stderr.includes(dependency));
		assert.match(result.stderr, /PATH/);
		assert.deepEqual(f.records(), []);
	});
}

test('missing installed dependencies fail without running an automatic install', (t) => {
	const f = fixture(t);
	fs.rmdirSync(path.join(f.root, 'node_modules'));
	const result = f.run();
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /npm ci/);
	assert.deepEqual(f.records(), []);
});

for (const [value, expected] of [
	['', '--openssl-legacy-provider'],
	['--trace-warnings --openssl-legacy-provider', '--trace-warnings --openssl-legacy-provider']
]) {
	test(`NODE_OPTIONS ${JSON.stringify(value)} retains exactly one legacy-provider flag`, (t) => {
		const f = fixture(t);
		const result = f.run([], { NODE_OPTIONS: value });
		assert.equal(result.status, 0, result.stderr);
		assert.ok(f.records().every(record => record.nodeOptions === expected));
	});
}

// Each injected failure executes the real wrapper. No later stage may package
// stale source, validate a failed bundle or announce success after rejection.
for (const [stage, preceding] of [
	['npm', ['npm']], ['package', ['npm', 'package']], ['python3', ['npm', 'package', 'python3']]
]) {
	test(`${stage} failure preserves the exit code and prevents subsequent stages`, (t) => {
		const f = fixture(t);
		const result = f.run([], { FAIL_STAGE: stage });
		assert.equal(result.status, 37, result.stderr);
		assert.deepEqual(f.records().map(record => record.stage), preceding);
		assert.doesNotMatch(result.stdout, /Rebuild complete/);
	});
}

for (const [arch, suffix] of [['x86_64', 'x86_64'], ['aarch64', 'arm64'], ['arm64', 'arm64']]) {
	test(`Linux ${arch} validates the matching native bundle`, (t) => {
		const f = fixture(t);
		const result = f.run([], { TEST_OS: 'Linux', TEST_ARCH: arch });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(f.records()[1].args, ['-p', 'l', '-f']);
		assert.deepEqual(f.records()[2].args,
			['tools/branding/check-package.py', `app/staging/Zotero_linux-${suffix}`]);
	});
}

test('unsupported hosts and architectures fail before building', (t) => {
	for (const overrides of [{ TEST_OS: 'UnsupportedOS' }, { TEST_OS: 'Linux', TEST_ARCH: 'unknown' }]) {
		const f = fixture(t);
		const result = f.run([], overrides);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /unsupported/i);
		assert.deepEqual(f.records(), []);
	}
});

test('help needs no runtime and unknown arguments cannot accidentally start a build', (t) => {
	const f = fixture(t, { missing: ['node', 'npm', 'python3'] });
	for (const arg of ['--help', '-h']) {
		const result = f.run([arg]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Usage:/);
	}
	const result = f.run(['--unknown']);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Usage:/);
	assert.deepEqual(f.records(), []);
});
