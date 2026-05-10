# Builds the Tauri version of SkillManager.
#
# Usage:
#   .\build.ps1            # full build with NSIS installer (in src-tauri\target\release\bundle\)
#   .\build.ps1 -NoBundle  # just the .exe (faster, no installer)
#   .\build.ps1 -Dev       # run in dev mode with hot reload
param(
    [switch]$Dev,
    [switch]$NoBundle
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
