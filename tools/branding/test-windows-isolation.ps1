param([string]$Compiler = "${env:ProgramFiles(x86)}\NSIS\makensis.exe")
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ("epilib-isolation-" + [guid]::NewGuid())
New-Item -ItemType Directory $root | Out-Null

# Use real NSIS guards against disposable fixture directories. This script must
# never inspect installed programs, shared profiles, or the real registry.
try {
    $result = Join-Path $root 'result.txt'
    foreach ($owned in @($false, $true)) {
        $exe = Join-Path $root "guard-$owned.exe"
        $arguments = @('/V2', "/DHARNESS_EXE=$exe", "/DHARNESS_RESULT=$result")
        if ($owned) { $arguments += '/DREQUIRE_OWNED' }
        $arguments += (Join-Path $PSScriptRoot 'windows-isolation-harness.nsi')
        & $Compiler @arguments
        if ($LASTEXITCODE -ne 0) { throw 'NSIS ownership harness compilation failed' }

        foreach ($case in @('missing', 'empty', 'official', 'other-files', 'wrong-marker', 'epilib', 'profile', 'library')) {
            $directory = Join-Path $root "$owned-$case"
            if ($case -ne 'missing') { New-Item -ItemType Directory $directory | Out-Null }
            if ($case -in @('official', 'epilib')) {
                Set-Content (Join-Path $directory 'zotero.exe') 'fixture, not a real executable'
            }
            if ($case -eq 'other-files') { Set-Content (Join-Path $directory 'research.txt') 'keep me' }
            if ($case -in @('wrong-marker', 'epilib', 'profile', 'library')) {
                $identity = if ($case -eq 'wrong-marker') { 'another-product' } else { 'epilib-desktop' }
                Set-Content (Join-Path $directory 'epilib-install.ini') "[Product]`nInstallerIdentity=$identity" -Encoding ascii
            }
            if ($case -eq 'profile') { Set-Content (Join-Path $directory 'prefs.js') 'keep my credentials' }
            if ($case -eq 'library') { Set-Content (Join-Path $directory 'zotero.sqlite') 'keep my library' }

            # The uninstall guard tests product ownership, not library location;
            # uninstall separately preserves profiles and only deletes logged files.
            $expected = if ($owned) { $case -in @('epilib', 'profile', 'library') }
                else { $case -in @('missing', 'empty', 'epilib') }
            $before = @(Get-ChildItem $directory -File -ErrorAction SilentlyContinue | Get-FileHash | Select-Object Path, Hash | ConvertTo-Json -Compress)
            Remove-Item $result -ErrorAction SilentlyContinue
            Start-Process $exe -ArgumentList @('/S', "/D=$directory") -Wait
            if ((Test-Path $result) -ne $expected) { throw "Unexpected guard result: owned=$owned case=$case" }
            $after = @(Get-ChildItem $directory -File -ErrorAction SilentlyContinue | Get-FileHash | Select-Object Path, Hash | ConvertTo-Json -Compress)
            if (($before -join '') -ne ($after -join '')) { throw "Guard mutated fixture $case" }
            Write-Output "PASS owned=$owned case=$case (input files unchanged)"
        }
    }
}
finally {
    # Delete only the unique temporary fixture root created above.
    Remove-Item $root -Recurse -Force
}
