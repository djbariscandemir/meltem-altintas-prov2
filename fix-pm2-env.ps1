# PM2 env düzeltmesi - Sunucuda ecosystem.config.cjs ile başlat
# Önce deploy yap (ecosystem.config.cjs sunucuya gitsin), sonra bu script'i çalıştır
# Veya ecosystem.config.cjs zaten sunucudaysa doğrudan bu script'i çalıştır

$Server = '89.167.50.117'
$SshUser = if ($env:DEPLOY_USER) { $env:DEPLOY_USER } else { 'root' }
$SshTarget = "${SshUser}@${Server}"

Write-Host "ecosystem.config.cjs sunucuda yoksa once: .\deploy-bot.ps1" -ForegroundColor Yellow
Write-Host ""

$commands = @'
cd /opt/meltem-bot
pm2 delete meltem-bot 2>/dev/null || true
[ -f ecosystem.config.cjs ] || { echo "HATA: ecosystem.config.cjs yok. Once deploy yap: .\deploy-bot.ps1"; exit 1; }
[ -f .env ] || { echo "HATA: .env yok"; exit 1; }
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root 2>&1 | grep "sudo env" | bash 2>/dev/null || true
echo ""
echo "=== PM2 STATUS ==="
pm2 status
echo ""
echo "=== PM2 LOGS (son 50 satir) ==="
pm2 logs meltem-bot --lines 50 --nostream
'@

# Heredoc-style: script'i dosyaya yaz, scp ile gonder, ssh ile calistir
$tmpSh = Join-Path $env:TEMP "fix-pm2-$(Get-Random).sh"
$commands | Set-Content -Path $tmpSh -Encoding UTF8
$content = [System.IO.File]::ReadAllText($tmpSh).Replace("`r`n", "`n")
[System.IO.File]::WriteAllText($tmpSh, $content)

scp -o StrictHostKeyChecking=no $tmpSh "${SshTarget}:/tmp/fix-pm2.sh"
ssh -o StrictHostKeyChecking=no "$SshTarget" "chmod +x /tmp/fix-pm2.sh && /tmp/fix-pm2.sh"
ssh -o StrictHostKeyChecking=no "$SshTarget" "rm -f /tmp/fix-pm2.sh" 2>$null
Remove-Item $tmpSh -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Canli loglar icin: ssh $SshTarget 'pm2 logs meltem-bot'" -ForegroundColor Yellow
