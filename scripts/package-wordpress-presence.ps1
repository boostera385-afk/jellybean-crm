$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$source = Join-Path $root 'integrations\wordpress\jellybean-presence'
$output = Join-Path $root 'releases\wordpress'
New-Item -ItemType Directory -Force $output | Out-Null
# Package only this reviewed plugin folder. Never include environment files,
# provisioning output, API keys or the whole repository.
$zip = Join-Path $output 'jellybean-presence-1.1.0.zip'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [System.IO.File]::Open($zip, [System.IO.FileMode]::Create)
$archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in @('jellybean-presence.php', 'readme.txt', 'uninstall.php', 'assets/presence.js')) {
        # ZIP entry separators MUST be '/', including when built on Windows:
        # the WordPress host may be Linux.
        $entry = $archive.CreateEntry("jellybean-presence/$file")
        $entry.LastWriteTime = [System.DateTimeOffset]::Parse('2026-10-16T00:00:00+00:00')
        $inputFile = [System.IO.File]::OpenRead((Join-Path $source $file))
        $entryStream = $entry.Open()
        try { $inputFile.CopyTo($entryStream) }
        finally { $entryStream.Dispose(); $inputFile.Dispose() }
    }
} finally {
    $archive.Dispose()
    $stream.Dispose()
}
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
Set-Content -Path "$zip.sha256" -Value "$hash  jellybean-presence-1.1.0.zip" -Encoding ascii
Write-Output "Created $zip"
Write-Output "SHA256: $hash"
