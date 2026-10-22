param(
    [Parameter(Mandatory = $true)][string]$UpstreamSource,
    [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
$sourcePath = (Resolve-Path -LiteralPath $UpstreamSource).Path
$targetPath = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $targetPath) { throw 'Destination must not exist; this recipe never overwrites an existing tree.' }
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'source-manifest.json') -Raw | ConvertFrom-Json
$patchPath = Join-Path $PSScriptRoot 'chisa-dynamic-git.patch'
if ((Get-FileHash -LiteralPath $patchPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.patchSha256) { throw 'Patch digest does not match manifest.' }
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Get-LFHash([string]$name) {
    if (-not (Test-Path -LiteralPath $name)) { return $null }
    $text = [IO.File]::ReadAllText($name).Replace("`r`n", "`n")
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($text))).Replace('-', '').ToLowerInvariant()) } finally { $sha.Dispose() }
}
foreach ($entry in $manifest.files) {
    $actual = Get-LFHash (Join-Path $sourcePath $entry.path)
    if ($actual -ne $entry.beforeSha256LF) { throw "Upstream source mismatch: $($entry.path)" }
}
Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Recurse
Get-ChildItem -LiteralPath $targetPath -Recurse -File | ForEach-Object { $_.IsReadOnly = $false }
Push-Location -LiteralPath $targetPath
try {
    & git -c core.autocrlf=false apply --check --whitespace=nowarn $patchPath
    if ($LASTEXITCODE -ne 0) { throw 'Patch preflight failed.' }
    & git -c core.autocrlf=false apply --whitespace=nowarn $patchPath
    if ($LASTEXITCODE -ne 0) { throw 'Patch application failed.' }
} finally { Pop-Location }
foreach ($entry in $manifest.files) {
    $actual = Get-LFHash (Join-Path $targetPath $entry.path)
    if ($actual -ne $entry.afterSha256LF) { throw "Replayed source mismatch: $($entry.path)" }
}
Write-Output "Replayed $($manifest.version), $($manifest.files.Count) changed source files; no binaries built."
