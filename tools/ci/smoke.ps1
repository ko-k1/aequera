# Local smoke check (Windows). Mirrors PR CI step for step.
$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$CliDir = Join-Path $Root "tools\cli"
# Workspace root owns the shared target dir (Cargo.toml [workspace]).
$Bin = Join-Path $Root "target\debug\aequera.exe"

Push-Location $CliDir
try {
    cargo fmt --all --check
    if ($LASTEXITCODE -ne 0) { throw "cargo fmt --check failed" }
    cargo clippy --workspace --all-targets -- -D warnings
    if ($LASTEXITCODE -ne 0) { throw "cargo clippy failed" }
    cargo test --workspace
    if ($LASTEXITCODE -ne 0) { throw "cargo test failed" }
    cargo build
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
}
finally {
    Pop-Location
}

Push-Location $Root
try {
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
