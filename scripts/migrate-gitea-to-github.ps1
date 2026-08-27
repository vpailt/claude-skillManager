#Requires -Version 5.1

<#
.SYNOPSIS
    Importe tous les dépôts d'une organisation Gitea dans une organisation GitHub,
    en réécrivant « acx-cl » en « cl ».

.DESCRIPTION
    Pour chaque dépôt de l'organisation Gitea :
      1. clone superficiel de la branche par défaut ;
      2. abandon de l'historique - un unique commit d'import initial est créé ;
      3. renommage de tout fichier ou dossier dont le nom contient « acx-cl » ;
      4. réécriture de la chaîne « acx-cl » dans le contenu des fichiers texte ;
      5. repointage des références de forge « <hôte Gitea>/<org> » et des champs
         JSON « "<org>/… » vers « github.com/<GitHubOrg> » (sauf -KeepForgeUrls) ;
      6. création de <GitHubOrg>/<nom sans le préfixe « acx- »> sur GitHub ;
      7. push de l'arborescence réécrite.

    Rien d'autre n'est réécrit. Les mentions « AlmaviaCX », les adresses
    @almaviacx.com et les chemins ~/.claude documentés par les skills sont
    conservés. Le rapport final indique, dépôt par dépôt, combien d'occurrences
    de « acx » subsistent, afin de pouvoir les relire.

    Jetons attendus :
      $env:GITEA_TOKEN   jeton Gitea (lecture des dépôts de l'organisation) - obligatoire
      $env:GH_TOKEN      jeton GitHub ; à défaut, celui de « gh auth token »

.PARAMETER DryRun
    Prépare tout localement et affiche le rapport, sans rien créer ni pousser sur
    GitHub. Les arborescences préparées restent dans -WorkDir.

.PARAMETER Force
    Autorise le push vers un dépôt GitHub déjà existant (push --force). Sans ce
    commutateur, un dépôt déjà présent est ignoré.

.PARAMETER Public
    Crée les dépôts GitHub en public. Par défaut ils sont privés.

.PARAMETER KeepForgeUrls
    Laisse les références pointant vers le Gitea interne en l'état, au lieu de
    les repointer vers github.com/<GitHubOrg>. Utile pour un miroir strict.

.EXAMPLE
    $env:GITEA_TOKEN = '<jeton>'
    .\migrate-gitea-to-github.ps1 -DryRun

.EXAMPLE
    $env:GITEA_TOKEN = '<jeton>'
    .\migrate-gitea-to-github.ps1
#>

[CmdletBinding()]
param(
    [string]   $GiteaUrl  = 'https://git.almaviacx.local',
    [string]   $GiteaOrg  = 'Claude',
    [string]   $GitHubOrg = 'sforge-labs',
    [string]   $WorkDir   = (Join-Path $env:TEMP 'gitea2gh'),
    [string[]] $Only      = @(),
    [string[]] $Skip      = @(),
    [switch]   $DryRun,
    [switch]   $Public,
    [switch]   $Force,
    [switch]   $IncludeArchived,
    [switch]   $InsecureTls,
    [switch]   $KeepForgeUrls,
    [switch]   $KeepWorkDir
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$SEARCH  = 'acx-cl'
$REPLACE = 'cl'

# Extensions never scanned for text replacement. The NUL-byte probe below is the
# real guard; this list only avoids reading large media files for nothing.
$BINARY_EXT = @(
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svgz',
    '.pdf', '.zip', '.gz', '.tgz', '.7z', '.rar', '.jar', '.class',
    '.exe', '.dll', '.so', '.dylib', '.pdb', '.bin',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.mp3', '.mp4', '.mov', '.avi', '.webm',
    '.xlsx', '.xls', '.docx', '.doc', '.pptx', '.ppt'
)

# ----------------------------------------------------------------- affichage --

function Write-Step  { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Info  { param([string]$Message) Write-Host "    $Message" -ForegroundColor Gray }
function Write-Ok    { param([string]$Message) Write-Host "    $Message" -ForegroundColor Green }
function Write-Alert { param([string]$Message) Write-Host "    $Message" -ForegroundColor Yellow }
function Write-Fail  { param([string]$Message) Write-Host "    $Message" -ForegroundColor Red }

# -------------------------------------------------------------------- outils --

function Resolve-Tool {
    param([Parameter(Mandatory)][string] $Name, [string[]] $Fallbacks = @())

    $cmd = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($candidate in $Fallbacks) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

function Invoke-Api {
    param(
        [Parameter(Mandatory)][string] $Url,
        [string] $Method = 'GET',
        [string] $AuthHeader,
        [string] $Body,
        [switch] $Insecure
    )

    $curlArgs = @(
        '--silent', '--show-error', '--location', '--max-time', '120',
        '--write-out', "`n%{http_code}",
        '--request', $Method,
        '--header', 'Accept: application/json',
        '--header', 'User-Agent: migrate-gitea-to-github'
    )
    if ($Insecure)   { $curlArgs += '--insecure' }
    if ($AuthHeader) { $curlArgs += @('--header', $AuthHeader) }
    if ($Body)       { $curlArgs += @('--header', 'Content-Type: application/json', '--data-binary', '@-') }
    $curlArgs += $Url

    if ($Body) { $raw = $Body | & $script:Curl @curlArgs }
    else       { $raw = & $script:Curl @curlArgs }

    $lines = @($raw)
    if ($lines.Count -eq 0) { throw "Aucune réponse de $Url" }

    $status = 0
    [void][int]::TryParse(($lines[-1] -replace '\D', ''), [ref]$status)
    $text = ''
    if ($lines.Count -gt 1) { $text = ($lines[0..($lines.Count - 2)] -join "`n") }

    $json = $null
    if ($text.Trim()) {
        try { $json = $text | ConvertFrom-Json } catch { $json = $null }
    }

    return [pscustomobject]@{ Status = $status; Text = $text; Json = $json }
}

function Invoke-Git {
    param(
        [Parameter(Mandatory)][string[]] $Arguments,
        [string] $WorkTree,
        [switch] $AllowFailure
    )

    $all = @()
    if ($WorkTree) { $all += @('-C', $WorkTree) }
    $all += $Arguments

    # Native stderr surfaces as ErrorRecords: under 'Stop' a plain git warning
    # (LF/CRLF, detached HEAD...) would abort the run even though git exited 0.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $script:Git @all 2>&1
        $code   = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previous }

    if ($code -ne 0 -and -not $AllowFailure) {
        throw ("git {0} a échoué (code {1}) :`n{2}" -f ($Arguments -join ' '), $code, ($output -join "`n"))
    }
    return [pscustomobject]@{ ExitCode = $code; Output = ($output -join "`n") }
}

function Remove-Tree {
    param([Parameter(Mandatory)][string] $Path)

    if (-not (Test-Path -LiteralPath $Path)) { return }
    # Git marks pack files read-only; Remove-Item refuses those without help.
    Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.Attributes -band [IO.FileAttributes]::ReadOnly) {
            $_.Attributes = $_.Attributes -bxor [IO.FileAttributes]::ReadOnly
        }
    }
    Remove-Item -LiteralPath $Path -Recurse -Force
}

# ----------------------------------------------------------------- réécriture --

function Test-BinaryContent {
    param([Parameter(Mandatory)][byte[]] $Bytes)

    $probe = [Math]::Min($Bytes.Length, 8192)
    for ($i = 0; $i -lt $probe; $i++) {
        if ($Bytes[$i] -eq 0) { return $true }
    }
    return $false
}

function Rename-MatchingPaths {
    param([Parameter(Mandatory)][string] $Root)

    # Deepest-first: renaming a leaf never invalidates the FullName of a shallower
    # item still queued, so one snapshot of the tree is enough.
    $items = Get-ChildItem -LiteralPath $Root -Recurse -Force |
             Sort-Object -Property @{ Expression = { ($_.FullName -split '\\').Count } } -Descending

    $renamed = 0
    foreach ($item in $items) {
        if ($item.Name.IndexOf($SEARCH, [StringComparison]::Ordinal) -lt 0) { continue }

        $newName = $item.Name.Replace($SEARCH, $REPLACE)
        $parent  = Split-Path -Parent $item.FullName
        $target  = Join-Path $parent $newName
        if (Test-Path -LiteralPath $target) {
            throw "Collision de renommage : « $($item.FullName) » -> « $target » existe déjà."
        }
        Rename-Item -LiteralPath $item.FullName -NewName $newName
        $renamed++
    }
    return $renamed
}

function Update-MatchingContent {
    param(
        [Parameter(Mandatory)][string] $Root,
        [Parameter(Mandatory)][array]  $Substitutions
    )

    # ISO-8859-1 maps bytes to chars one-for-one and back, so the substitution is
    # byte-exact: encoding, BOM and line endings of every file survive untouched.
    $latin1 = [System.Text.Encoding]::GetEncoding(28591)
    $files  = Get-ChildItem -LiteralPath $Root -Recurse -File -Force

    $touched = 0
    $byLabel = @{}
    foreach ($rule in $Substitutions) { $byLabel[$rule.Label] = 0 }

    foreach ($file in $files) {
        if ($BINARY_EXT -contains $file.Extension.ToLowerInvariant()) { continue }
        if ($file.Length -gt 16MB) { continue }

        $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
        if ($bytes.Length -eq 0) { continue }
        if (Test-BinaryContent -Bytes $bytes) { continue }

        $text    = $latin1.GetString($bytes)
        $updated = $text
        # Rules are applied in order: each one sees the previous one's output,
        # which is what lets the forge rules match paths acx-cl already renamed.
        foreach ($rule in $Substitutions) {
            if ($updated.IndexOf($rule.From, [StringComparison]::Ordinal) -lt 0) { continue }
            $byLabel[$rule.Label] += ([regex]::Matches($updated, [regex]::Escape($rule.From))).Count
            $updated = $updated.Replace($rule.From, $rule.To)
        }

        if ($updated -eq $text) { continue }
        [System.IO.File]::WriteAllBytes($file.FullName, $latin1.GetBytes($updated))
        $touched++
    }
    return [pscustomobject]@{ Files = $touched; ByLabel = $byLabel }
}

function Measure-ResidualAcx {
    param([Parameter(Mandatory)][string] $Root)

    $latin1 = [System.Text.Encoding]::GetEncoding(28591)
    $files  = Get-ChildItem -LiteralPath $Root -Recurse -File -Force

    $hits = 0
    foreach ($file in $files) {
        if ($BINARY_EXT -contains $file.Extension.ToLowerInvariant()) { continue }
        if ($file.Length -gt 16MB) { continue }

        $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
        if ($bytes.Length -eq 0) { continue }
        if (Test-BinaryContent -Bytes $bytes) { continue }

        $hits += ([regex]::Matches($latin1.GetString($bytes), 'acx', 'IgnoreCase')).Count
    }
    return $hits
}

function ConvertTo-AsciiJson {
    param([Parameter(Mandatory)][hashtable] $Object)

    $json = $Object | ConvertTo-Json -Compress -Depth 5
    # Guarantee an ASCII-only body: the payload travels through a pipe to curl,
    # whose encoding we do not control.
    return [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
}

# ------------------------------------------------------------------ préflight --

Write-Step 'Vérification de l''environnement'

$script:Curl = Resolve-Tool -Name 'curl.exe'
if (-not $script:Curl) { throw 'curl.exe est introuvable dans le PATH.' }

$script:Git = Resolve-Tool -Name 'git.exe'
if (-not $script:Git) { throw 'git.exe est introuvable dans le PATH.' }

$giteaToken = $env:GITEA_TOKEN
if (-not $giteaToken) {
    throw 'Aucun jeton Gitea. Définissez $env:GITEA_TOKEN (jeton d''accès personnel Gitea, portée lecture des dépôts) avant de relancer.'
}

$githubToken = $env:GH_TOKEN
if (-not $githubToken) { $githubToken = $env:GITHUB_TOKEN }
if (-not $githubToken) {
    $ghCli = Resolve-Tool -Name 'gh.exe' -Fallbacks @(
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\GitHub.cli_Microsoft.Winget.Source_8wekyb3d8bbwe\bin\gh.exe')
    )
    if ($ghCli) {
        $githubToken = (& $ghCli auth token 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -ne 0) { $githubToken = $null }
    }
}
if (-not $githubToken) {
    throw 'Aucun jeton GitHub. Définissez $env:GH_TOKEN, ou authentifiez-vous avec « gh auth login ».'
}

$giteaAuth  = "Authorization: token $giteaToken"
$githubAuth = "Authorization: Bearer $githubToken"
$giteaRoot  = $GiteaUrl.TrimEnd('/')
$giteaHost  = ([System.Uri] $giteaRoot).Host

# Ordered substitution pipeline applied to every text file. The forge rules run
# after the acx-cl one, so they see owner paths in their already-renamed form.
# They are deliberately narrow: only the "<forge>/<org>/" prefix and the quoted
# "<org>/" of a JSON repo field, never a bare "Claude" or the ~/.claude paths
# that skills legitimately document.
$substitutions = @(
    @{ Label = 'acx'; From = $SEARCH; To = $REPLACE }
)
if (-not $KeepForgeUrls) {
    $substitutions += @{ Label = 'forge'; From = "$giteaRoot/$GiteaOrg/"; To = "https://github.com/$GitHubOrg/" }
    $substitutions += @{ Label = 'forge'; From = "$giteaHost/$GiteaOrg/"; To = "github.com/$GitHubOrg/" }
    $substitutions += @{ Label = 'forge'; From = "`"$GiteaOrg/";          To = "`"$GitHubOrg/" }
}

$me = Invoke-Api -Url "$giteaRoot/api/v1/user" -AuthHeader $giteaAuth -Insecure:$InsecureTls
if ($me.Status -ne 200) {
    throw "Gitea a répondu HTTP $($me.Status) sur /api/v1/user. Jeton invalide, ou VPN non connecté.`n$($me.Text)"
}
Write-Ok "Gitea : connecté en tant que $($me.Json.login)"

$ghMe = Invoke-Api -Url 'https://api.github.com/user' -AuthHeader $githubAuth
if ($ghMe.Status -ne 200) {
    throw "GitHub a répondu HTTP $($ghMe.Status) sur /user. Jeton invalide ou expiré.`n$($ghMe.Text)"
}
$ghOrg = Invoke-Api -Url "https://api.github.com/orgs/$GitHubOrg" -AuthHeader $githubAuth
if ($ghOrg.Status -ne 200) {
    throw "GitHub a répondu HTTP $($ghOrg.Status) sur /orgs/$GitHubOrg. Organisation inconnue ou jeton sans accès.`n$($ghOrg.Text)"
}
Write-Ok "GitHub : connecté en tant que $($ghMe.Json.login), organisation $GitHubOrg accessible"

$authorName  = (Invoke-Git -Arguments @('config', '--get', 'user.name')  -AllowFailure).Output.Trim()
$authorEmail = (Invoke-Git -Arguments @('config', '--get', 'user.email') -AllowFailure).Output.Trim()
if (-not $authorName)  { $authorName  = $ghMe.Json.login }
if (-not $authorEmail) { $authorEmail = "$($ghMe.Json.login)@users.noreply.github.com" }

# -------------------------------------------------------- inventaire des dépôts --

Write-Step "Inventaire de $giteaRoot/$GiteaOrg"

$repos = @()
$page  = 1
while ($true) {
    $url  = "$giteaRoot/api/v1/orgs/$GiteaOrg/repos?limit=50&page=$page"
    $resp = Invoke-Api -Url $url -AuthHeader $giteaAuth -Insecure:$InsecureTls
    if ($resp.Status -ne 200) {
        throw "Listing des dépôts impossible (HTTP $($resp.Status)) :`n$($resp.Text)"
    }
    $batch = @($resp.Json)
    if ($batch.Count -eq 0) { break }
    $repos += $batch
    if ($batch.Count -lt 50) { break }
    $page++
}

Write-Ok "$($repos.Count) dépôt(s) trouvé(s)"

$selected = @()
foreach ($repo in $repos) {
    $name = $repo.name

    if ($Only.Count -gt 0) {
        $match = $false
        foreach ($pattern in $Only) { if ($name -like $pattern) { $match = $true; break } }
        if (-not $match) { continue }
    }
    $excluded = $false
    foreach ($pattern in $Skip) { if ($name -like $pattern) { $excluded = $true; break } }
    if ($excluded) { Write-Info "$name : ignoré (-Skip)"; continue }

    if ($repo.empty) { Write-Alert "$name : dépôt vide, ignoré"; continue }
    if ($repo.archived -and -not $IncludeArchived) {
        Write-Alert "$name : archivé, ignoré (utilisez -IncludeArchived pour l'inclure)"
        continue
    }
    $selected += $repo
}

if ($selected.Count -eq 0) {
    Write-Alert 'Aucun dépôt à traiter.'
    return
}

Write-Info "$($selected.Count) dépôt(s) retenu(s) : $(($selected | ForEach-Object { $_.name }) -join ', ')"

# ---------------------------------------------------------------- traitement --

if (Test-Path -LiteralPath $WorkDir) { Remove-Tree -Path $WorkDir }
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null

$report   = @()
$failures = 0

foreach ($repo in $selected) {
    $source = $repo.name
    $target = $source -replace '^acx-', ''
    $branch = $repo.default_branch
    if (-not $branch) { $branch = 'main' }
    $dest   = Join-Path $WorkDir $target

    $row = [pscustomobject]@{
        Source   = $source
        Cible    = $target
        Branche  = $branch
        Renommes = 0
        Fichiers = 0
        AcxCl    = 0
        Urls     = 0
        ResteAcx = 0
        Statut   = ''
    }

    Write-Step "$source  ->  $GitHubOrg/$target"

    try {
        # core.autocrlf is commonly true on Windows, which would rewrite line
        # endings on checkout and again on commit. Forcing it off on both sides
        # is what makes the imported blobs byte-identical to the source ones.
        $cloneArgs = @('-c', 'core.autocrlf=false')
        if ($InsecureTls) { $cloneArgs += @('-c', 'http.sslVerify=false') }
        $cloneArgs += @('-c', "http.extraheader=Authorization: token $giteaToken")
        $cloneArgs += @('clone', '--quiet', '--depth', '1', '--single-branch',
                        '--branch', $branch, $repo.clone_url, $dest)
        Invoke-Git -Arguments $cloneArgs | Out-Null

        $sourceSha = (Invoke-Git -Arguments @('rev-parse', 'HEAD') -WorkTree $dest).Output.Trim()
        Remove-Tree -Path (Join-Path $dest '.git')
        Write-Info "clone de $branch à $($sourceSha.Substring(0, 7))"

        $row.Renommes = Rename-MatchingPaths -Root $dest
        $rewrite      = Update-MatchingContent -Root $dest -Substitutions $substitutions
        $row.Fichiers = $rewrite.Files
        $row.AcxCl    = $rewrite.ByLabel['acx']
        if ($rewrite.ByLabel.ContainsKey('forge')) { $row.Urls = $rewrite.ByLabel['forge'] }
        $row.ResteAcx = Measure-ResidualAcx -Root $dest
        Write-Info "$($row.Renommes) chemin(s) renommé(s), $($row.AcxCl) occurrence(s) acx-cl et $($row.Urls) référence(s) de forge réécrites dans $($row.Fichiers) fichier(s)"
        if ($row.ResteAcx -gt 0) {
            Write-Alert "$($row.ResteAcx) occurrence(s) de « acx » subsistent (URL Gitea, mentions AlmaviaCX) - à relire"
        }

        $description = ''
        if ($repo.description) {
            $description = $repo.description
            foreach ($rule in $substitutions) { $description = $description.Replace($rule.From, $rule.To) }
        }

        $messageLines = @(
            "chore: initial import from $GiteaOrg/$source",
            '',
            "Imported from $giteaRoot/$GiteaOrg/$source at $sourceSha.",
            "History was not carried over. Every '$SEARCH' occurrence was rewritten",
            "to '$REPLACE', in file and directory names as well as in file contents."
        )
        if (-not $KeepForgeUrls) {
            $messageLines += "Forge references were repointed from $giteaHost/$GiteaOrg to"
            $messageLines += "github.com/$GitHubOrg."
        }
        $message = $messageLines -join "`n"

        Invoke-Git -Arguments @('init', '--quiet', '--initial-branch', $branch) -WorkTree $dest | Out-Null
        Invoke-Git -Arguments @('config', '--local', 'core.autocrlf', 'false') -WorkTree $dest | Out-Null
        Invoke-Git -Arguments @('add', '--all') -WorkTree $dest | Out-Null
        Invoke-Git -Arguments @(
            '-c', "user.name=$authorName", '-c', "user.email=$authorEmail",
            'commit', '--quiet', '-m', $message
        ) -WorkTree $dest | Out-Null

        if ($DryRun) {
            $row.Statut = 'préparé (dry-run)'
            Write-Ok "préparé dans $dest - rien n'a été poussé"
            $report += $row
            continue
        }

        $existing = Invoke-Api -Url "https://api.github.com/repos/$GitHubOrg/$target" -AuthHeader $githubAuth
        if ($existing.Status -eq 200) {
            if (-not $Force) {
                $row.Statut = 'ignoré (existe déjà)'
                Write-Alert "$GitHubOrg/$target existe déjà - ignoré (utilisez -Force pour écraser sa branche)"
                $report += $row
                continue
            }
            Write-Alert "$GitHubOrg/$target existe déjà - push --force demandé"
        }
        elseif ($existing.Status -eq 404) {
            $payload = ConvertTo-AsciiJson -Object @{
                name        = $target
                description = $description
                private     = (-not $Public.IsPresent)
                auto_init   = $false
            }
            $created = Invoke-Api -Url "https://api.github.com/orgs/$GitHubOrg/repos" `
                                  -Method 'POST' -AuthHeader $githubAuth -Body $payload
            if ($created.Status -ne 201) {
                throw "Création de $GitHubOrg/$target refusée (HTTP $($created.Status)) :`n$($created.Text)"
            }
            $visibility = 'privé'
            if ($Public) { $visibility = 'public' }
            Write-Ok "dépôt $visibility créé"
        }
        else {
            throw "État de $GitHubOrg/$target indéterminé (HTTP $($existing.Status)) :`n$($existing.Text)"
        }

        $basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$githubToken"))
        Invoke-Git -Arguments @('remote', 'add', 'origin', "https://github.com/$GitHubOrg/$target.git") -WorkTree $dest | Out-Null
        Invoke-Git -Arguments @('config', '--local', 'http.https://github.com/.extraheader', "AUTHORIZATION: basic $basic") -WorkTree $dest | Out-Null

        $pushArgs = @('push', '--quiet', '--set-upstream')
        if ($Force) { $pushArgs += '--force' }
        $pushArgs += @('origin', $branch)
        Invoke-Git -Arguments $pushArgs -WorkTree $dest | Out-Null

        # The credential lives in the work tree's config until cleanup; drop it now.
        Invoke-Git -Arguments @('config', '--local', '--unset', 'http.https://github.com/.extraheader') -WorkTree $dest -AllowFailure | Out-Null

        $row.Statut = 'poussé'
        Write-Ok "poussé sur https://github.com/$GitHubOrg/$target ($branch)"
    }
    catch {
        $failures++
        $row.Statut = 'ÉCHEC'
        Write-Fail $_.Exception.Message
    }

    $report += $row
}

# ------------------------------------------------------------------- rapport --

Write-Host ''
Write-Step 'Rapport'
$report | Format-Table -AutoSize -Property Source, Cible, Branche, Renommes, Fichiers, AcxCl, Urls, ResteAcx, Statut

$pushed = @($report | Where-Object { $_.Statut -eq 'poussé' }).Count
Write-Host ''
Write-Info "$pushed dépôt(s) poussé(s), $failures échec(s) sur $($report.Count) traité(s)."

if ($DryRun) {
    Write-Alert "Dry-run : rien n'a été créé sur GitHub. Arborescences préparées dans $WorkDir"
}
elseif ($KeepWorkDir) {
    Write-Info "Répertoire de travail conservé : $WorkDir"
}
else {
    Remove-Tree -Path $WorkDir
}

if ($failures -gt 0) { exit 1 }
