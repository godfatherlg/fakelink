# One-command release for the fakelink Obsidian plugin.
#
#   .\release.ps1                 # patch bump, publish, deploy into the default vault
#   .\release.ps1 -Bump minor
#   .\release.ps1 -SkipVault
#
# The release itself is done by GitHub Actions (.github/workflows/release.yml),
# which triggers on a tag push, builds the plugin there and publishes it with
# the contents of RELEASE_NOTES.md as the release body plus main.js /
# manifest.json / styles.css as assets. This script only drives that flow, in
# the one order that works, so the release is never created twice - creating a
# release by hand while the workflow is running is what leaves an empty body.
#
# Before running: commit your source changes AND the updated RELEASE_NOTES.md
# (its first line must be "# <next version>"), because the workflow reads that
# file from the tagged commit.
[CmdletBinding()]
param(
    [ValidateSet('patch', 'minor', 'major')] [string] $Bump = 'patch',
    [string] $Repo   = 'godfatherlg/fakelink',
    [string] $Branch = 'master',
    [string] $Vault  = 'J:\OB\.obsidian\plugins\fakelink',
    # A vault that has never run the plugin - it has no data.json, so it is the
    # only place where "fresh install" bugs show up. Deploy there too, always.
    [string] $TestVault = 'F:\OBtest\test\.obsidian\plugins\fakelink',
    [int]    $TimeoutSeconds = 300,
    [switch] $SkipVault
)

# Native commands write progress to stderr; with 'Stop' PowerShell would treat
# that as a failure. Every step is checked through $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "ABORT: $msg" -ForegroundColor Red; exit 1 }
function Assert-Ok($what) { if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit code $LASTEXITCODE)" } }

Step 'Checking the working tree'
$dirty = git status --porcelain
Assert-Ok 'git status'
if ($dirty) { Fail "the working tree is not clean - commit or stash first:`n$dirty" }
$current = (Get-Content manifest.json -Raw -Encoding UTF8 | ConvertFrom-Json).version
if (-not $current) { Fail 'could not read the version from manifest.json' }

$p = $current.Split('.')
$major = [int]$p[0]; $minor = [int]$p[1]; $patch = [int]$p[2]
switch ($Bump) {
    'major' { $major++; $minor = 0; $patch = 0 }
    'minor' { $minor++; $patch = 0 }
    default { $patch++ }
}
$next = "$major.$minor.$patch"
Write-Host "version: $current -> $next ($Bump)"

Step 'Checking RELEASE_NOTES.md'
if (-not (Test-Path -LiteralPath 'RELEASE_NOTES.md')) { Fail 'RELEASE_NOTES.md is missing - the release body comes from it' }
$firstLine = (Get-Content RELEASE_NOTES.md -TotalCount 1 -Encoding UTF8).Trim()
if ($firstLine -ne "# $next") {
    Fail "RELEASE_NOTES.md starts with '$firstLine' but the next version is $next - update it first (first line must be '# $next')."
}
if (git tag -l $next) { Fail "tag $next already exists" }

Step "Bumping to $next"
npm version $Bump --no-git-tag-version
Assert-Ok 'npm version'

Step 'Committing'
git add -A
git commit -m "chore: release $next"
Assert-Ok 'git commit'

Step 'Tagging and pushing'
git tag $next
Assert-Ok 'git tag'
git push origin $Branch
Assert-Ok "git push $Branch"
git push origin $next
Assert-Ok "git push $next"

Step "Waiting for the Release workflow on tag $next"
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$run = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 10
    $runs = (gh run list --repo $Repo --workflow release.yml --limit 10 --json databaseId,status,conclusion,headBranch) | ConvertFrom-Json
    $run = $runs | Where-Object { $_.headBranch -eq $next } | Select-Object -First 1
    if ($run -and $run.status -eq 'completed') { break }
}
if (-not $run) { Fail "no workflow run appeared for tag $next - check https://github.com/$Repo/actions" }
if ($run.conclusion -ne 'success') { Fail "the workflow finished as '$($run.conclusion)' - check https://github.com/$Repo/actions/runs/$($run.databaseId)" }

Step 'Verifying the published release'
$rel = (gh release view $next --repo $Repo --json author,isDraft,isPrerelease,assets,url) | ConvertFrom-Json
if ($rel.isDraft) { Fail 'the release is still a draft' }
if ($rel.assets.Count -lt 3) { Fail "the release has $($rel.assets.Count) asset(s) - expected main.js, manifest.json, styles.css" }
Write-Host "url     : $($rel.url)"
Write-Host "author  : $($rel.author.login)  (github-actions[bot] = published by the workflow)"
Write-Host "assets  : $(($rel.assets | ForEach-Object { $_.name }) -join ', ')"

if (-not $SkipVault) {
    Step "Deploying the published assets into $Vault"
    if (-not (Test-Path -LiteralPath $Vault)) {
        Write-Host "vault folder not found, skipping: $Vault" -ForegroundColor Yellow
    } else {
        gh release download $next --repo $Repo --pattern main.js --pattern manifest.json --pattern styles.css --dir $Vault --clobber
        Assert-Ok 'gh release download'
        Write-Host "deployed - reload the plugin in Obsidian to pick up $next"
    }

    Step "Deploying into the test vault ($TestVault)"
    if (Test-Path -LiteralPath $TestVault) {
        gh release download $next --repo $Repo --pattern main.js --pattern manifest.json --pattern styles.css --dir $TestVault --clobber
        Assert-Ok 'gh release download (test vault)'
        Write-Host "installed into the test vault." -ForegroundColor Yellow
        Write-Host "NOW RELOAD THAT VAULT AND LOOK AT THE SETTINGS TAB:" -ForegroundColor Yellow
        Write-Host "  a vault that never ran this plugin has no data.json, which is exactly" -ForegroundColor Yellow
        Write-Host "  the case that 1.23.32 fixed - the settings tab must appear." -ForegroundColor Yellow
    } else {
        Write-Host "test vault not found, skipping: $TestVault" -ForegroundColor Yellow
    }
}

Write-Host "`nDone: $next" -ForegroundColor Green
