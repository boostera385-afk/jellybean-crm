param([string]$Php = '8.3', [string]$WordPress = '6.8')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$env:TEMP = Join-Path $env:LOCALAPPDATA 'Temp\opencode'
$env:TMP = $env:TEMP
& npx --yes '@wp-playground/cli@3.1.58' run-blueprint `
    --blueprint (Join-Path $root 'integrations\wordpress\tests\install-blueprint.json') `
    --mount-dir (Join-Path $root 'releases\wordpress') '/release' `
    --mount-dir (Join-Path $root 'integrations\wordpress\tests') '/tests' `
    --site-url 'https://example.com' --wp=$WordPress --php=$Php
if ($LASTEXITCODE -ne 0) { throw 'WordPress installer/REST regression failed' }
Write-Output "PASS: exact plugin ZIP installation, activation, settings, diagnostics, REST and uninstall (WP $WordPress / PHP $Php)"
