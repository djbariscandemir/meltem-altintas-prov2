#!/bin/bash
# Sunucuda çalıştır: /opt/meltem-bot dizininde
# PM2 process sil, ecosystem ile başlat, env doğrula

set -e
cd /opt/meltem-bot

echo "[1/7] PM2 process siliniyor..."
pm2 delete meltem-bot 2>/dev/null || true

echo "[2/7] ecosystem.config.cjs kontrol..."
[ -f ecosystem.config.cjs ] || { echo "HATA: ecosystem.config.cjs bulunamadı"; exit 1; }
[ -f .env ] || { echo "HATA: .env bulunamadı"; exit 1; }

echo "[3/7] PM2 ecosystem ile başlatılıyor..."
pm2 start ecosystem.config.cjs

echo "[4/7] pm2 save..."
pm2 save

echo "[5/7] pm2 startup (reboot sonrası otomatik başlatma)..."
pm2 startup systemd -u root --hp /root 2>&1 | grep "sudo env" | bash 2>/dev/null || true

echo "[6/7] PM2 status..."
pm2 status

echo "[7/7] pm2 logs (Ctrl+C ile çık)..."
pm2 logs meltem-bot
