# Builds dist\SkillManager.exe (single file, windowed).
# Usage:  .\build.ps1
$ErrorActionPreference = "Stop"

Write-Host "==> Cleaning old build artifacts" -ForegroundColor Cyan
Remove-Item -Recurse -Force build, dist -ErrorAction SilentlyContinue

Write-Host "==> Ensuring deps are installed" -ForegroundColor Cyan
python -m pip install -q -r requirements.txt

Write-Host "==> Running PyInstaller" -ForegroundColor Cyan
python -m PyInstaller --noconfirm SkillManager.spec

if (Test-Path "dist\SkillManager.exe") {
    $size = (Get-Item "dist\SkillManager.exe").Length / 1MB
    Write-Host ("==> Built dist\SkillManager.exe  ({0:N1} MB)" -f $size) -ForegroundColor Green
} else {
    Write-Host "==> Build failed: dist\SkillManager.exe not found" -ForegroundColor Red
    exit 1
}
