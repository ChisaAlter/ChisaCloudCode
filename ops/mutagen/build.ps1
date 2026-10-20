param(
    [string]$Go = 'go',
    [string]$OutputDirectory = (Join-Path $PSScriptRoot ('../../build/mutagen-' + (Get-Date -Format 'yyyyMMdd-HHmmss')))
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Build the Windows desktop runtime on Windows.' }
$goExecutable = (Get-Command $Go -ErrorAction Stop).Source
$goVersion = & $goExecutable version
if ($LASTEXITCODE -ne 0 -or $goVersion -notmatch 'go1\.27\.1\s') { throw 'Use Go 1.27.1 for the documented runtime build.' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw "Choose a new output directory; existing files are preserved: $output" }
New-Item -ItemType Directory -Path $output | Out-Null
$module = & $goExecutable mod download -json github.com/mutagen-io/mutagen@v0.18.1 | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $module.Sum -ne 'h1:uYR9CHuynFNO0zGFMypI2LseX9VkIYlgfWQeI/j4824=') { throw 'Pinned upstream module verification failed.' }
$upstream = Join-Path $output 'upstream'
Expand-Archive -LiteralPath $module.Zip -DestinationPath $upstream
$source = Join-Path $upstream 'github.com/mutagen-io/mutagen@v0.18.1'
$patch = Join-Path $PSScriptRoot 'chisa-0.18.1-chisa.2.patch'
& git -C $source apply --check -- $patch
if ($LASTEXITCODE -ne 0) { throw 'The source does not match the Chisa patch.' }
& git -C $source apply -- $patch
if ($LASTEXITCODE -ne 0) { throw 'Could not apply the Chisa patch.' }
$previousPath = $env:PATH
try {
    $env:PATH = (Split-Path -Parent $goExecutable) + [IO.Path]::PathSeparator + $previousPath
    Push-Location $source
    try {
        & $goExecutable test ./pkg/synchronization/endpoint/remote -run '^Test' -count=1 -timeout=120s
        if ($LASTEXITCODE -ne 0) { throw 'Completion protocol tests failed.' }
        & $goExecutable test ./pkg/service/synchronization -run '^TestIgnoreUpdate' -count=1 -timeout=120s
        if ($LASTEXITCODE -ne 0) { throw 'Ignore update tests failed.' }
        & $goExecutable run scripts/build.go --mode slim
        if ($LASTEXITCODE -ne 0) { throw 'Runtime compilation failed.' }
    } finally { Pop-Location }
} finally { $env:PATH = $previousPath }
Copy-Item -LiteralPath (Join-Path $source 'build/cli/windows_amd64') -Destination (Join-Path $output 'mutagen.exe')
Copy-Item -LiteralPath (Join-Path $source 'build/mutagen-agents.tar.gz') -Destination (Join-Path $output 'mutagen-agents.tar.gz')
$version = & (Join-Path $output 'mutagen.exe') version
if ($LASTEXITCODE -ne 0 -or $version.Trim() -ne '0.18.1-chisa.2') { throw 'Built runtime identity mismatch.' }
$files = foreach ($name in @('mutagen.exe', 'mutagen-agents.tar.gz')) {
    $file = Get-Item -LiteralPath (Join-Path $output $name)
    [ordered]@{ path = $name; bytes = $file.Length; sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
}
[ordered]@{ version = '0.18.1-chisa.2'; sourceVersion = 'v0.18.1'; files = @($files) } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'runtime-dependencies.json') -Encoding utf8
Write-Output "Built runtime and integrity manifest: $output"
