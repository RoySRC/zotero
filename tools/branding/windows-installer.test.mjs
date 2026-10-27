import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

/** Read installer sources without invoking or altering a real installation. */
const read = file => fs.readFileSync(new URL(`../../app/win/installer/${file}`, import.meta.url), 'utf8');
const installer = read('installer.nsi');
const uninstaller = read('uninstaller.nsi');
const shared = read('shared.nsh');
const common = read('common.nsh');

test('installer identity and registry discovery belong only to EpiLib', () => {
	assert.match(read('branding.nsi'), /BrandFullNameInternal\s+"EpiLib"/);
	assert.match(read('defines.nsi'), /InstallerRegistryKey\s+"Software\\EpiLib"/);
	assert.match(read('defines.nsi'), /AppPathAlias\s+"EpiLib\.exe"/);
	for (const source of [installer, uninstaller, shared]) {
		assert.doesNotMatch(source, /"Software\\(?:Zotero|zotero\.org)\\?/i);
		assert.doesNotMatch(source, /App Paths\\\$\{FileMainEXE\}/);
	}
	assert.match(common, /GetSingleInstallPath\} "\$\{InstallerRegistryKey\}\\\$\{BrandFullNameInternal\}"/);
	assert.match(common, /StrCmp \$R9 "\$\{BrandFullNameInternal\} " \+1 loop/);
});

test('install and uninstall cannot kill a shared executable or remove another product', () => {
	for (const source of [installer, uninstaller]) {
		assert.doesNotMatch(source, /nsProcess::|Call UninstallOld|Function UninstallOld/);
		assert.doesNotMatch(source, /\$\{(?:un\.)?ManualCloseAppPrompt\}/);
		assert.doesNotMatch(source, /Delete[^\n]*\\\*\.(?:exe|dll|chk)/);
	}
});

test('ownership guards run before installation mutations and helper/uninstaller actions', () => {
	assert.match(installer, /Section "-InstallStartCleanup"\s*;[^\n]*\n\s*!insertmacro EpiLibCheckInstallDirectory/);
	assert.match(installer, /Function CheckExistingInstall\s+!insertmacro EpiLibCheckInstallDirectory/);
	assert.match(uninstaller, /Section "Uninstall"\s+!insertmacro EpiLibRequireOwnedInstall/);
	for (let name of ['.onInit', 'un.onInit']) {
		let section = uninstaller.split(`Function ${name}\n`)[1].split('FunctionEnd')[0];
		assert.ok(section.indexOf('EpiLibRequireOwnedInstall') > 0);
		let mutation = section.search(/(?:RmDir|DeleteFile|PostUpdate)\}/);
		assert.ok(mutation < 0 || section.indexOf('EpiLibRequireOwnedInstall') < mutation);
	}
});

test('uninstall retains profiles, credentials and shared runtime caches', () => {
	assert.doesNotMatch(uninstaller, /DeleteRelativeProfiles|UN_REMOVE_PROFILES|\$APPDATA|\$LOCALAPPDATA/);
	assert.doesNotMatch(uninstaller, /ApplicationID::UninstallJumpLists/);
	assert.doesNotMatch(installer + uninstaller, /CleanUpdatesDir\} "Zotero\\Zotero"/);
	assert.match(uninstaller, /Settings, credentials and library data will be retained/);
});

test('file associations use EpiLib ProgIDs without replacing existing defaults', () => {
	for (const [ext, id] of Object.entries({ ris: 'RIS', isi: 'ISI', mods: 'MODS', rdf: 'RDF', bib: 'BibTeX', bibtex: 'BibTeX', marc: 'MARC', csl: 'CSL' })) {
		let block = shared.split(`ReadRegStr $6 HKCR ".${ext}" ""`)[1]?.split('${EndIf}')[0];
		assert.ok(block, `Missing merged-registry check for ${ext}`);
		assert.ok(block.includes('${If} "$6" == ""'), `Must not replace an existing ${ext} handler`);
		assert.ok(block.includes(`"EpiLib${id}"`));
		assert.ok(uninstaller.includes(`"EpiLib${id}"`));
	}
	assert.doesNotMatch(shared + uninstaller, /"(?:Software\\Classes\\)?Zotero(?:RIS|ISI|MODS|RDF|BibTeX|MARC|CSL)"/);
	const cleanup = common.split('Function ${_MOZFUNC_UN}RegCleanFileHandler')[1].split('FunctionEnd')[0];
	assert.doesNotMatch(cleanup, /DeleteRegKey HKCU/);
	assert.ok(cleanup.includes('DeleteRegValue HKCU "Software\\Classes\\$R9" ""'));
});

test('compatible zotero URLs are registered only when unclaimed or already owned', () => {
	const protocol = shared.split('ReadRegStr $6 HKCR "zotero\\shell\\open\\command" ""')[1]?.split('${EndIf}')[0];
	assert.ok(protocol);
	assert.ok(protocol.includes('${If} $6 == ""'));
	assert.ok(protocol.includes('${OrIf} $R9 == "true"'));
	assert.ok(protocol.includes('${IsHandlerForInstallDir} "zotero" $R9'));
	// Elevated launch must not read the protocol owner's path (possibly Zotero).
	const launch = installer.split('Function LaunchAppFromElevatedProcess')[1].split('FunctionEnd')[0];
	assert.match(launch, /App Paths\\\$\{AppPathAlias\}/);
	assert.doesNotMatch(launch, /Classes\\zotero/);
});

test('Windows packages carry the ownership marker expected by the installer', () => {
	const build = fs.readFileSync(new URL('../../app/build.sh', import.meta.url), 'utf8');
	const marker = fs.readFileSync(new URL('../../app/assets/epilib-install.ini', import.meta.url), 'utf8');
	assert.match(marker, /^InstallerIdentity=epilib-desktop$/m);
	assert.match(build, /cp "\$CALLDIR\/assets\/epilib-install.ini" "\$APPDIR\/epilib-install.ini"/);
	assert.match(installer, /\$EXEDIR\\core\\\$\{InstallMarker\}/);
	assert.match(read('isolation.nsh'), /\$INSTDIR\\\$\{InstallMarker\}/);
});

test('elevated launch preserves spaces in App Paths and verifies ownership', () => {
	const launch = installer.split('Function LaunchAppFromElevatedProcess')[1].split('FunctionEnd')[0];
	assert.doesNotMatch(launch, /GetPathFromString/);
	assert.ok(launch.includes('${GetParent} "$0" $INSTDIR'));
	assert.ok(launch.includes('SetOutPath "$INSTDIR"'));
	assert.ok(launch.indexOf('EpiLibRequireOwnedInstall') > 0);
	assert.ok(launch.indexOf('EpiLibRequireOwnedInstall') < launch.indexOf('SetOutPath'));
});
