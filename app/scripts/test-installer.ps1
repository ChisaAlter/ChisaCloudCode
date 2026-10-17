param([string]$Makensis = "$env:LOCALAPPDATA/mygo/nsis-3.13/Bin/makensis.exe")
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path $PSScriptRoot -Parent
$testRoot = Join-Path $appRoot ('build/installer-tests/' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$fixtureId = 'com.chisa.installer-test.' + [guid]::NewGuid().ToString('N')
$product = 'ChisaInstallerFixture-' + [guid]::NewGuid().ToString('N')
$exeName = "$product.exe"
$source = Join-Path $testRoot 'replacement.bin'
[IO.File]::WriteAllText($source, 'replacement')
$preflight = Join-Path $testRoot 'preflight.nsh'
$payload = Join-Path $testRoot 'payload.nsh'
$uninstall = Join-Path $testRoot 'uninstall.nsh'
@'
StrCpy $CheckedPath "$INSTDIR\${PRODUCT_NAME}.exe"
Call RequireWritableFile
StrCpy $CheckedPath "$INSTDIR\payload\resource.dat"
Call RequireWritableFile
'@ | Set-Content -LiteralPath $preflight -Encoding utf8
@'
SetOutPath "$INSTDIR"
IfErrors install_failed
File /oname=${PRODUCT_NAME}.exe "__SOURCE__"
IfErrors install_failed
SetOutPath "$INSTDIR\payload"
IfErrors install_failed
File /oname=resource.dat "__SOURCE__"
IfErrors install_failed
'@.Replace('__SOURCE__', $source) | Set-Content -LiteralPath $payload -Encoding utf8
@'
Delete "$INSTDIR\${PRODUCT_NAME}.exe"
Delete "$INSTDIR\payload\resource.dat"
RMDir "$INSTDIR\payload"
'@ | Set-Content -LiteralPath $uninstall -Encoding utf8
$installer = Join-Path $testRoot 'fixture-setup.exe'
$arguments = @('/V2', '/INPUTCHARSET', 'UTF8', "/DPRODUCT_NAME=$product", "/DPRODUCT_ID=$fixtureId", '/DPRODUCT_VERSION=0.0.0',
    "/DINSTALLER_OUTPUT=$installer", "/DINSTALLER_ICON=$appRoot/installer/icon.ico", "/DPREFLIGHT_INCLUDE=$preflight", "/DPAYLOAD_INCLUDE=$payload", "/DUNINSTALL_INCLUDE=$uninstall", "$appRoot/installer/windows.nsi")
& $Makensis @arguments
if ($LASTEXITCODE -ne 0) { throw "Fixture compilation failed: $LASTEXITCODE" }

foreach ($lockedRelative in @($exeName, 'payload/resource.dat', 'mutagen.exe')) {
    $destination = Join-Path $testRoot ([guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path "$destination/payload" -Force | Out-Null
    [IO.File]::WriteAllText("$destination/$exeName", 'original application')
    [IO.File]::WriteAllText("$destination/payload/resource.dat", 'original resource')
    # An invalid local fixture executable exercises daemon-stop failure without
    # contacting or stopping any real Mutagen daemon.
    if ($lockedRelative -eq 'mutagen.exe') { [IO.File]::WriteAllText("$destination/mutagen.exe", 'unavailable daemon fixture') }
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

    $process = Start-Process -FilePath "$destination/Uninstall.exe" -ArgumentList "/S _?=$destination" -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Fixture uninstall failed: $($process.ExitCode)" }
    if ((Test-Path -LiteralPath "$destination/$exeName") -or (Test-Path -LiteralPath "$destination/payload/resource.dat")) { throw 'Uninstall retained installed payload files' }
    if ([IO.File]::ReadAllText("$destination/user-project.txt") -ne 'keep root user data' -or
        [IO.File]::ReadAllText("$destination/payload/user-file.txt") -ne 'keep nested user data') { throw 'Uninstall removed user-owned files' }
    Write-Output 'PASS: uninstall removes known payload and preserves unknown root and nested files'
} finally {
    $registry.DeleteSubKeyTree($registryPath, $false)
    $registry.Dispose()
}
Write-Output "Fixture evidence: $testRoot"
