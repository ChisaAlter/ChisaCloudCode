param(
  [Parameter(Mandatory=$true)][string]$Python,
  [string]$Gpg = 'C:\Program Files\Git\usr\bin\gpg.exe',
  [string]$Log = 'docs/remediation/2026-10-31/W01/fixture-tests.log'
)
$ErrorActionPreference = 'Stop'
$env:CHISA_TEST_GPG = $Gpg
$env:PYTHONIOENCODING = 'utf-8'
& $Python -B ops/recovery/tests/run_tests.py --log $Log
$testExit = $LASTEXITCODE
Write-Output "fixture_test_exit=$testExit"
exit $testExit
