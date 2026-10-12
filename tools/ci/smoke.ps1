# Local smoke check (Windows). Mirrors PR CI step for step.
$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$CliDir = Join-Path $Root "tools\cli"
# Cargo workspace target dir: member builds land in $Root\target, never in
# tools\cli\target (no such directory exists).
$Bin = Join-Path $Root "target\debug\aequera.exe"

Push-Location $CliDir
try {
    cargo fmt --all --check
    if ($LASTEXITCODE -ne 0) { throw "cargo fmt --check failed" }
    cargo clippy --workspace --all-targets -- -D warnings
    if ($LASTEXITCODE -ne 0) { throw "cargo clippy failed" }
    cargo test --workspace --locked
    if ($LASTEXITCODE -ne 0) { throw "cargo test failed" }
    cargo build --workspace --locked
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
}
finally {
    Pop-Location
}

Push-Location $Root
try {
    # Pure JS models (shell, extensions): node's built-in runner, no packages.
    # Tracked files only, listed explicitly: a glob that matches nothing makes
    # `node --test` pass with zero tests, so an empty list fails instead.
    $NodeTests = @(git ls-files ':(glob)aequera/**/*.test.js' ':(glob)aequera/**/*.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw "git ls-files failed" }
    if ($NodeTests.Count -eq 0) { throw "no node tests found under aequera/" }
    node --test @NodeTests
    if ($LASTEXITCODE -ne 0) { throw "node --test failed" }
    & $Bin doctor
    if ($LASTEXITCODE -ne 0) { throw "aequera doctor failed" }
    & $Bin upstream status
    if ($LASTEXITCODE -ne 0) { throw "aequera upstream status failed" }
    & $Bin patch status
    if ($LASTEXITCODE -ne 0) { throw "aequera patch status failed" }
    & $Bin config validate
    if ($LASTEXITCODE -ne 0) { throw "aequera config validate failed" }
}
finally {
    Pop-Location
}

Write-Output "smoke: all green"
