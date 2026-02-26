# meltem-bot deployment script - Windows PowerShell
# Deploys to Ubuntu 24.04 at 89.167.50.117
# Usage: .\deploy-bot.ps1
# Or set: $env:DEPLOY_USER='root' before running if not root

$ErrorActionPreference = 'Stop'
$Server = '89.167.50.117'
$DeployPath = '/opt/meltem-bot'
$ZipName = 'meltem-bot.zip'
$DeployShName = 'deploy-remote.sh'

# Default SSH user (override with $env:DEPLOY_USER)
$SshUser = if ($env:DEPLOY_USER) { $env:DEPLOY_USER } else { 'root' }
$SshTarget = "${SshUser}@${Server}"

Write-Host "[1/6] Preparing bundle..." -ForegroundColor Cyan
$Root = $PSScriptRoot
if (-not $Root) { $Root = Get-Location }
Set-Location $Root

if (-not (Test-Path (Join-Path $Root 'scripts'))) { throw 'scripts/ klasoru bulunamadi.' }
if (-not (Test-Path (Join-Path $Root 'package.json'))) { throw 'package.json bulunamadi.' }

# Zip: sadece scripts/, package.json, package-lock.json, ecosystem.config.cjs, .env
# node_modules, .git ve gereksiz klasorler HARIC
$zipPath = Join-Path $Root $ZipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

$tempDir = Join-Path $env:TEMP "meltem-bot-deploy-$(Get-Random)"
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
try {
    if (Test-Path (Join-Path $Root 'scripts')) {
        Write-Host "  + scripts/ (node_modules, .git excluded)"
        $rc = & robocopy (Join-Path $Root 'scripts') (Join-Path $tempDir 'scripts') /E /XD node_modules .git /NFL /NDL /NJH /NJS
        if ($LASTEXITCODE -ge 8) { throw "Robocopy failed: $LASTEXITCODE" }
    }
    foreach ($item in @('package.json', 'package-lock.json', 'ecosystem.config.cjs', '.env')) {
        $src = Join-Path $Root $item
        if (Test-Path $src) {
            Write-Host "  + $item"
            Copy-Item $src $tempDir -Force
        }
    }
    Compress-Archive -Path (Join-Path $tempDir '*') -DestinationPath $zipPath -Force
} finally {
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
if (-not (Test-Path $zipPath)) { throw 'Zip olusturulamadi.' }
Write-Host "  Created $ZipName" -ForegroundColor Green

Write-Host "[2/6] Creating remote deploy script..." -ForegroundColor Cyan
$deploySh = @'
#!/bin/bash
set -e
cd /opt/meltem-bot

echo "[Remote] Cleaning and extracting..."
rm -rf node_modules
unzip -o meltem-bot.zip
rm -f meltem-bot.zip

echo "[Remote] Verifying structure..."
ls -la
[ -d scripts ] && ls -la scripts || true

echo "[Remote] Installing dependencies..."
npm install

echo "[Remote] Installing Playwright Chromium..."
npx playwright install chromium
npx playwright install-deps chromium 2>/dev/null || true

echo "[Remote] Ensuring PM2..."
command -v pm2 >/dev/null 2>&1 || npm install -g pm2

echo "[Remote] Starting with PM2 (ecosystem.config.cjs)..."
pm2 delete meltem-bot 2>/dev/null || true
[ -f ecosystem.config.cjs ] && pm2 start ecosystem.config.cjs || pm2 start scripts/fetchRevyWithLogin.js --name meltem-bot --interpreter node
pm2 save
pm2 startup systemd -u root --hp /root 2>&1 | grep "sudo env" | bash 2>/dev/null || true

echo ""
echo "=== PM2 STATUS ==="
pm2 status
'@

$deployShPath = Join-Path $Root $DeployShName
$deploySh | Set-Content -Path $deployShPath -Encoding UTF8 -NoNewline
# Ensure Unix line endings for bash
$content = [System.IO.File]::ReadAllText($deployShPath).Replace("`r`n", "`n")
[System.IO.File]::WriteAllText($deployShPath, $content)

Write-Host "[3/6] Uploading to server..." -ForegroundColor Cyan
ssh -o StrictHostKeyChecking=no "$SshTarget" "mkdir -p $DeployPath"
scp -o StrictHostKeyChecking=no $zipPath "${SshTarget}:${DeployPath}/"
scp -o StrictHostKeyChecking=no $deployShPath "${SshTarget}:${DeployPath}/"

Write-Host "[4/6] Running remote deploy..." -ForegroundColor Cyan
ssh -o StrictHostKeyChecking=no "$SshTarget" "chmod +x ${DeployPath}/${DeployShName} && ${DeployPath}/${DeployShName}"

Write-Host "[5/6] Cleanup..." -ForegroundColor Cyan
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
Remove-Item $deployShPath -Force -ErrorAction SilentlyContinue
ssh -o StrictHostKeyChecking=no "$SshTarget" "rm -f ${DeployPath}/${DeployShName}" 2>$null

Write-Host "[6/6] Done." -ForegroundColor Green
Write-Host "Bot is running at $Server. Check: ssh $SshTarget 'pm2 logs meltem-bot'" -ForegroundColor Yellow
