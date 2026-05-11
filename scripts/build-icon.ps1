# Generates the SkillManager icon set under src-tauri/icons/:
#   32x32.png, 128x128.png, 128x128@2x.png (256x256), icon.ico (multi-size).
#
# Design: rounded square with an indigo→violet diagonal gradient and a
# centered 4-point white sparkle — matches the in-app theming (the indigo
# violet of the primary accent and the lucide-react `Sparkles` glyph used to
# mark skills). Run any time you want to refresh the artwork:
#
#     pwsh -File .\scripts\build-icon.ps1
#
# This script generates the source PNGs and then delegates the .ico assembly
# to `npx tauri icon`, which produces a properly-formatted multi-resolution
# .ico that Windows Explorer renders correctly at every size. A hand-rolled
# .ico writer (which we used to have here) produced files that LoadLibraryEx
# accepted but SHGetFileInfo rendered as a flat color, so we stopped doing it.
#
# After running this, rebuild the app (.\build.ps1 -NoBundle). You may also
# need to clear %LOCALAPPDATA%\IconCache.db and Explorer's iconcache_*.db so
# Windows picks up the new icon on already-known paths.

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$iconsDir = Join-Path $root 'src-tauri/icons'
if (-not (Test-Path $iconsDir)) { New-Item -ItemType Directory -Path $iconsDir | Out-Null }

# Palette: indigo-600 (#4F46E5) → violet-500 (#8B5CF6). Matches the primary
# accent of the in-app theme so the launcher icon visually reads as "this app".
$top    = [System.Drawing.Color]::FromArgb(255,  79,  70, 229)
$bottom = [System.Drawing.Color]::FromArgb(255, 139,  92, 246)

function Get-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc($x,           $y,           $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y,           $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d,   0, 90)
    $path.AddArc($x,           $y + $h - $d, $d, $d,  90, 90)
    $path.CloseFigure()
    return $path
}

function New-IconBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode    = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode  = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    # Rounded background with gradient.
    $radius = [single]([Math]::Max(2, $size * 0.20))
    $bgPath = Get-RoundedPath 0 0 $size $size $radius
    $gradRect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($gradRect, $top, $bottom, 45.0)
    $g.FillPath($brush, $bgPath)
    $brush.Dispose()

    # Subtle inner highlight at top-left (gives the gradient some depth).
    if ($size -ge 48) {
        $highlightRect = New-Object System.Drawing.Rectangle(0, 0, [int]($size * 0.7), [int]($size * 0.7))
        $hlBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            $highlightRect,
            [System.Drawing.Color]::FromArgb(40, 255, 255, 255),
            [System.Drawing.Color]::FromArgb(0, 255, 255, 255),
            135.0
        )
        $g.FillPath($hlBrush, $bgPath)
        $hlBrush.Dispose()
    }

    # Centered 4-point sparkle (white). Polygon with 8 vertices: outer cardinals
    # alternating with inner diagonals to make the concave star. We use
    # `[Type]::new(...)` instead of `New-Object Type(...)` because the latter
    # mis-parses in Windows PowerShell 5.1 (`(a, b - c)` becomes an array minus
    # a scalar).
    $cx = [single]($size / 2.0)
    $cy = [single]($size / 2.0)
    $outer = [single]($size * 0.36)
    $inner = [single]($size * 0.085)
    $pts = @(
        [System.Drawing.PointF]::new($cx,           $cy - $outer),  # N
        [System.Drawing.PointF]::new($cx + $inner,  $cy - $inner),
        [System.Drawing.PointF]::new($cx + $outer,  $cy),           # E
        [System.Drawing.PointF]::new($cx + $inner,  $cy + $inner),
        [System.Drawing.PointF]::new($cx,           $cy + $outer),  # S
        [System.Drawing.PointF]::new($cx - $inner,  $cy + $inner),
        [System.Drawing.PointF]::new($cx - $outer,  $cy),           # W
        [System.Drawing.PointF]::new($cx - $inner,  $cy - $inner)
    )
    $sparkle = New-Object System.Drawing.Drawing2D.GraphicsPath
    $sparkle.AddPolygon($pts)

    # Soft drop-shadow on larger sizes for a touch of dimension.
    if ($size -ge 48) {
        $matrix = New-Object System.Drawing.Drawing2D.Matrix
        $matrix.Translate(0, [single]([Math]::Max(1, $size * 0.015)))
        $shadowPath = $sparkle.Clone()
        $shadowPath.Transform($matrix)
        $shadow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(60, 0, 0, 0))
        $g.FillPath($shadow, $shadowPath)
        $shadow.Dispose()
    }

    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $g.FillPath($white, $sparkle)
    $white.Dispose()

    # Two satellite mini-sparkles at small offsets — barely visible at 16px but
    # add character at 128+.
    if ($size -ge 64) {
        $miniBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 255, 255, 255))
        foreach ($pair in @(@(0.78, 0.22, 0.10), @(0.22, 0.80, 0.07))) {
            $mx = [single]($size * $pair[0])
            $my = [single]($size * $pair[1])
            $mr = [single]($size * $pair[2])
            $mi = [single]($mr * 0.22)
            $mpts = @(
                [System.Drawing.PointF]::new($mx,        $my - $mr),
                [System.Drawing.PointF]::new($mx + $mi,  $my - $mi),
                [System.Drawing.PointF]::new($mx + $mr,  $my),
                [System.Drawing.PointF]::new($mx + $mi,  $my + $mi),
                [System.Drawing.PointF]::new($mx,        $my + $mr),
                [System.Drawing.PointF]::new($mx - $mi,  $my + $mi),
                [System.Drawing.PointF]::new($mx - $mr,  $my),
                [System.Drawing.PointF]::new($mx - $mi,  $my - $mi)
            )
            $mp = New-Object System.Drawing.Drawing2D.GraphicsPath
            $mp.AddPolygon($mpts)
            $g.FillPath($miniBrush, $mp)
            $mp.Dispose()
        }
        $miniBrush.Dispose()
    }

    $g.Dispose()
    return $bmp
}

# --- Source PNG (1024x1024) ---
# `npx tauri icon` needs a high-resolution source. We render once at 1024 and
# let it downscale to every target — that produces sharper small sizes than
# rendering each target independently with our PS antialiasing.
$sourcePng = Join-Path $iconsDir 'app-icon.png'
$bmp = New-IconBitmap 1024
$bmp.Save($sourcePng, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "Wrote source $sourcePng"

# --- Delegate to `tauri icon` for .ico + .png/.icns/etc. ---
# It writes the proper multi-resolution icon.ico (with valid resource-section
# entries) that Windows Explorer renders correctly at every size — which our
# hand-rolled writer didn't.
$projectRoot = $root
Push-Location $projectRoot
try {
    Write-Host "Running: npx tauri icon `"$sourcePng`" --output src-tauri/icons"
    & npx tauri icon $sourcePng --output 'src-tauri/icons'
    if ($LASTEXITCODE -ne 0) { throw "npx tauri icon failed with exit $LASTEXITCODE" }
}
finally {
    Pop-Location
}
Write-Host "Done. Rebuild with .\build.ps1 -NoBundle to embed the new icon in the .exe."
