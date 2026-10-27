param(
    [string]$Makensis = "$env:LOCALAPPDATA/mygo/nsis-3.13/Bin/makensis.exe",
    [string]$Node = 'node'
)
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path $PSScriptRoot -Parent
$testRoot = Join-Path $appRoot ('build/installer-tests/' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$fixtureId = 'com.chisa.installer-test.' + [guid]::NewGuid().ToString('N')
$product = 'ChisaInstallerFixture-' + [guid]::NewGuid().ToString('N')
$exeName = "$product.exe"
# Exercise the actual payload/include generator with a tiny fake application.
# No native candidate or existing installed directory is used.
$fixtureApp = Join-Path $testRoot 'fixture-app'
foreach ($directory in @('scripts', 'installer', 'build/windows-amd64/payload')) {
    New-Item -ItemType Directory -Path (Join-Path $fixtureApp $directory) -Force | Out-Null
}
Copy-Item -LiteralPath "$appRoot/scripts/build-installer.mjs" -Destination "$fixtureApp/scripts/build-installer.mjs"
Copy-Item -LiteralPath "$appRoot/installer/windows.nsi" -Destination "$fixtureApp/installer/windows.nsi"
Copy-Item -LiteralPath "$appRoot/installer/icon.ico" -Destination "$fixtureApp/installer/icon.ico"
"export default { name: `"$product`", identifier: `"$fixtureId`", version: `"0.0.0`" };" | Set-Content -LiteralPath "$fixtureApp/mygo.config.ts" -Encoding utf8
[IO.File]::WriteAllText("$fixtureApp/build/windows-amd64/$exeName", 'replacement')
[IO.File]::WriteAllText("$fixtureApp/build/windows-amd64/payload/resource.dat", 'replacement')
$previousMakensis = $env:MAKENSIS
try {
    $env:MAKENSIS = $Makensis
    & $Node "$fixtureApp/scripts/build-installer.mjs"
    if ($LASTEXITCODE -ne 0) { throw "Fixture compilation failed: $LASTEXITCODE" }
} finally { $env:MAKENSIS = $previousMakensis }
$installer = Join-Path $fixtureApp "build/windows-amd64/$product Setup 0.0.0.exe"

foreach ($lockedRelative in @($exeName, 'payload/resource.dat')) {
    $destination = Join-Path $testRoot ([guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path "$destination/payload" -Force | Out-Null
    [IO.File]::WriteAllText("$destination/$exeName", 'original application')
    [IO.File]::WriteAllText("$destination/payload/resource.dat", 'original resource')
    $locked = [IO.File]::Open((Join-Path $destination $lockedRelative), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $process = Start-Process -FilePath $installer -ArgumentList "/S /D=$destination" -WindowStyle Hidden -Wait -PassThru
        if ($process.ExitCode -ne 32) { throw "Locked $lockedRelative returned $($process.ExitCode), expected 32" }
        if ([IO.File]::ReadAllText("$destination/$exeName") -ne 'original application' -or
            [IO.File]::ReadAllText("$destination/payload/resource.dat") -ne 'original resource' -or
            (Test-Path -LiteralPath "$destination/Uninstall.exe")) { throw 'Blocked installer modified its destination' }
        Write-Output "PASS: locked $lockedRelative exits 32 before replacing any file"
    } finally { $locked.Dispose() }
}

$destination = Join-Path $testRoot 'write-failure'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
[IO.File]::WriteAllText("$destination/payload", 'file blocks destination directory')
$process = Start-Process -FilePath $installer -ArgumentList "/S /D=$destination" -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 1) { throw "Write failure returned $($process.ExitCode), expected 1" }
if (Test-Path -LiteralPath "$destination/Uninstall.exe") { throw 'Failed installer reached completion registration' }
Write-Output 'PASS: destination write failure exits 1'
# Use a unique fixture key in the same 32-bit registry view as NSIS.
$registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry32)
$registryPath = "Software\Microsoft\Windows\CurrentVersion\Uninstall\$fixtureId"
$custom = Join-Path $testRoot 'registered-custom-location'
New-Item -ItemType Directory -Path $custom -Force | Out-Null
[IO.File]::WriteAllText("$custom/$exeName", 'old custom installation')
$key = $registry.CreateSubKey($registryPath)
$key.SetValue('InstallLocation', $custom)
$key.Dispose()
try {
    $locked = [IO.File]::Open("$custom/$exeName", [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $process = Start-Process -FilePath $installer -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
        if ($process.ExitCode -ne 32) { throw "Registered custom destination was bypassed: $($process.ExitCode)" }
        if ([IO.File]::ReadAllText("$custom/$exeName") -ne 'old custom installation') { throw 'Custom installation changed while locked' }
        Write-Output 'PASS: default destination follows registered custom install and rejects its locked executable'
    } finally { $locked.Dispose() }

    $destination = Join-Path $testRoot 'explicit-override'
    New-Item -ItemType Directory -Path "$destination/payload" -Force | Out-Null
    [IO.File]::WriteAllText("$destination/user-project.txt", 'keep root user data')
    [IO.File]::WriteAllText("$destination/payload/user-file.txt", 'keep nested user data')
    $process = Start-Process -FilePath $installer -ArgumentList "/S /D=$destination" -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Explicit destination install failed: $($process.ExitCode)" }
    $key = $registry.OpenSubKey($registryPath)
    try { if ($key.GetValue('InstallLocation') -ne $destination) { throw 'Explicit /D did not override registry default' } } finally { $key.Dispose() }
    Write-Output 'PASS: explicit /D overrides the registered directory'

    $locked = [IO.File]::Open("$destination/$exeName", [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $process = Start-Process -FilePath "$destination/Uninstall.exe" -ArgumentList "/S _?=$destination" -WindowStyle Hidden -Wait -PassThru
        if ($process.ExitCode -ne 32) { throw "Busy application uninstall returned $($process.ExitCode), expected 32" }
        $key = $registry.OpenSubKey($registryPath)
        try { if (-not $key) { throw 'Busy uninstall removed its registration' } } finally { if ($key) { $key.Dispose() } }
        if ([IO.File]::ReadAllText("$destination/$exeName") -ne 'replacement' -or
            [IO.File]::ReadAllText("$destination/payload/resource.dat") -ne 'replacement') { throw 'Busy uninstall changed installed payload' }
        Write-Output 'PASS: busy uninstall exits 32 before removing payload or registration'
    } finally { $locked.Dispose() }

    # The existing reader allows write access (preflight passes) but not deletion.
    # This reaches the generated Delete error path without a timing race.
    $locked = [IO.File]::Open("$destination/payload/resource.dat", [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        $process = Start-Process -FilePath "$destination/Uninstall.exe" -ArgumentList "/S _?=$destination" -WindowStyle Hidden -Wait -PassThru
        if ($process.ExitCode -ne 1) { throw "Payload delete failure returned $($process.ExitCode), expected 1" }
        $key = $registry.OpenSubKey($registryPath)
        try { if (-not $key -or $key.GetValue('UninstallString') -notlike '*Uninstall.exe*') { throw 'Failed uninstall lost its registered retry entry' } } finally { if ($key) { $key.Dispose() } }
        if (-not (Test-Path -LiteralPath "$destination/Uninstall.exe") -or
            [IO.File]::ReadAllText("$destination/payload/resource.dat") -ne 'replacement') { throw 'Delete failure lost retry executable or locked payload' }
        Write-Output 'PASS: payload delete failure exits 1 and retains the original registered uninstall entry'
    } finally {
        $locked.Dispose()

    }

    $process = Start-Process -FilePath "$destination/Uninstall.exe" -ArgumentList "/S _?=$destination" -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Fixture uninstall failed: $($process.ExitCode)" }
    if ((Test-Path -LiteralPath "$destination/$exeName") -or (Test-Path -LiteralPath "$destination/payload/resource.dat")) { throw 'Uninstall retained installed payload files' }
    if ([IO.File]::ReadAllText("$destination/user-project.txt") -ne 'keep root user data' -or
        [IO.File]::ReadAllText("$destination/payload/user-file.txt") -ne 'keep nested user data') { throw 'Uninstall removed user-owned files' }
    Write-Output 'PASS: uninstall removes known payload and preserves unknown root and nested files'

    $normal = Join-Path $testRoot 'normal-copied-uninstaller'
    $process = Start-Process -FilePath $installer -ArgumentList "/S /D=$normal" -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Normal-path fixture install failed: $($process.ExitCode)" }
    $process = Start-Process -FilePath "$normal/Uninstall.exe" -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Normal copied uninstaller launch failed: $($process.ExitCode)" }
    $waiting = [Diagnostics.Stopwatch]::StartNew()
    do {
        $key = $registry.OpenSubKey($registryPath)
        $registered = $null -ne $key
        if ($key) { $key.Dispose() }
        $retainedPayload = (Test-Path -LiteralPath "$normal/$exeName") -or (Test-Path -LiteralPath "$normal/payload/resource.dat") -or (Test-Path -LiteralPath "$normal/Uninstall.exe")
        if (-not $registered -and -not $retainedPayload) { break }
        Start-Sleep -Milliseconds 50
    } while ($waiting.ElapsedMilliseconds -lt 10000)
    if ($registered -or $retainedPayload) { throw 'Normal copied uninstaller did not finish payload and registration cleanup' }
    Write-Output 'PASS: normal /S copied-uninstaller path removes payload, original uninstaller and registration'
} finally {
    $registry.DeleteSubKeyTree($registryPath, $false)
    $registry.Dispose()
    foreach ($folder in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
        $shortcut = Join-Path $folder "$product.lnk"
        if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force }
    }
}
Write-Output "Fixture evidence: $testRoot"
