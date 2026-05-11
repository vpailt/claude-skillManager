# Builds the Tauri version of SkillManager.
#
# Usage:
#   .\build.ps1            # full build with NSIS installer (in src-tauri\target\release\bundle\)
#   .\build.ps1 -NoBundle  # just the .exe (faster, no installer)
#   .\build.ps1 -Dev       # run in dev mode with hot reload
#   .\build.ps1 -Clean     # wipe stale tauri/skillmanager build artifacts before building
#                            (use after moving the project on disk or upgrading tauri)
param(
    [switch]$Dev,
    [switch]$NoBundle,
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

# --- Locate prerequisites ---
$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
if (-not (Test-Path $cargo)) {
    Write-Host "==> Rust toolchain not found at $cargo" -ForegroundColor Red
    Write-Host "    Install with: winget install Rustlang.Rustup" -ForegroundColor Yellow
    exit 1
}
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

# vswhere.exe ships next to the Visual Studio Installer. vcvarsall.bat calls it
# internally to discover the install — if it's not on PATH (e.g. in a stripped
# CI/headless shell), vcvars writes an error to stderr that $ErrorActionPreference
# = "Stop" then promotes to a fatal exception. Prepend the standard Installer dir
# defensively so the script works in both interactive and non-interactive shells.
$vswhereDir = "C:\Program Files (x86)\Microsoft Visual Studio\Installer"
if ((Test-Path (Join-Path $vswhereDir "vswhere.exe")) -and ($env:PATH -notlike "*$vswhereDir*")) {
    $env:PATH = "$vswhereDir;$env:PATH"
}

$vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
if (-not (Test-Path $vcvars)) {
    $vcvars = "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
}
if (-not (Test-Path $vcvars)) {
    Write-Host "==> MSVC linker not found." -ForegroundColor Red
    Write-Host "    Install with: winget install Microsoft.VisualStudio.2022.BuildTools --override `"--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended`"" -ForegroundColor Yellow
    exit 1
}

Write-Host "==> Loading MSVC environment" -ForegroundColor Cyan
cmd /c "`"$vcvars`" x64 && set" 2>$null `
    | Where-Object { $_ -match '^(PATH|INCLUDE|LIB|LIBPATH)=' } `
    | ForEach-Object {
        $name, $value = $_ -split '=', 2
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }

if ($Clean) {
    Write-Host "==> Cleaning stale build artifacts (skillmanager + tauri)" -ForegroundColor Cyan
    & $cargo clean --release -p skillmanager --manifest-path src-tauri\Cargo.toml
    & $cargo clean --release -p tauri        --manifest-path src-tauri\Cargo.toml
}

if (-not (Test-Path "node_modules")) {
    Write-Host "==> Installing npm dependencies" -ForegroundColor Cyan
    npm install
}

if ($Dev) {
    Write-Host "==> Starting Tauri dev mode" -ForegroundColor Cyan
    npm run tauri dev
    exit 0
}

Write-Host "==> Building frontend (vite)" -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($NoBundle) {
    Write-Host "==> Building Tauri (no installer)" -ForegroundColor Cyan
    npm run tauri build -- --no-bundle
} else {
    Write-Host "==> Building Tauri (full bundle)" -ForegroundColor Cyan
    npm run tauri build
}

$exe = "src-tauri\target\release\skillmanager.exe"
if (Test-Path $exe) {
    $size = (Get-Item $exe).Length / 1MB
    Write-Host ("==> Built $exe  ({0:N1} MB)" -f $size) -ForegroundColor Green
    if (-not $NoBundle) {
        $bundleDir = "src-tauri\target\release\bundle"
        if (Test-Path $bundleDir) {
            Get-ChildItem -Recurse $bundleDir -Include *.exe, *.msi, *.nsis `
                | ForEach-Object {
                    Write-Host ("    bundle: {0}" -f $_.FullName) -ForegroundColor Green
                }
        }
    }
} else {
    Write-Host "==> Build failed: $exe not found" -ForegroundColor Red
    exit 1
}
