# Meltem Bot - Ubuntu Server Deployment

## Main Entry Point
**`scripts/fetchRevyWithLogin.js`** — Continuous Revy listing scraper (Playwright, human-like delays, working hours 09:00–22:00).

---

## 1. Local: Create deploy archive (exclude frontend, node_modules, .env)

**Windows (PowerShell):**
```powershell
cd c:\Users\yilma\meltem-altintas-pro
$items = @('scripts','revy-engine','package.json')
if (Test-Path package-lock.json) { $items += 'package-lock.json' }
if (Test-Path .auth) { $items += '.auth' }
Compress-Archive -Path $items -DestinationPath meltem-bot.zip -Force
```

**Linux/WSL/Git Bash:**
```bash
cd /path/to/meltem-altintas-pro
tar --exclude=node_modules --exclude=dist --exclude=.git --exclude=src --exclude=public --exclude=.env -cvf meltem-bot.tar .
```

---

## 2. SSH to server

```bash
ssh root@89.167.50.117
```

---

## 3. Create directory and upload

**On server:**
```bash
sudo mkdir -p /opt/meltem-bot
sudo chown $USER:$USER /opt/meltem-bot
```

**From local (new terminal):**
```bash
scp meltem-bot.zip root@89.167.50.117:/opt/meltem-bot/
```
*(If using .tar: `scp meltem-bot.tar root@89.167.50.117:/opt/meltem-bot/`)*

**On server:**
```bash
cd /opt/meltem-bot
unzip -o meltem-bot.zip
rm meltem-bot.zip
```
*(If using .tar: `tar -xvf meltem-bot.tar && rm meltem-bot.tar`)*

---

## 4. Create .env on server

```bash
nano /opt/meltem-bot/.env
```

Add:
```
SUPABASE_URL=https://akidlfqugftljfuhnjxn.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
REVY_PHONE=5xxxxxxxxx
REVY_PASSWORD=your-password
```

Save: `Ctrl+O`, `Enter`, `Ctrl+X`

---

## 5. Install dependencies and Playwright browsers

```bash
cd /opt/meltem-bot
npm install
npx playwright install chromium
npx playwright install-deps chromium
```

---

## 6. Install PM2 and start bot

```bash
sudo npm install -g pm2
pm2 start scripts/fetchRevyWithLogin.js --name meltem-bot --interpreter node
pm2 startup
```
*(Run the command that `pm2 startup` outputs, e.g. `sudo env PATH=... pm2 startup systemd -u root --hp /root`)*
```bash
pm2 save
```

---

## 7. Monitoring commands

```bash
pm2 logs meltem-bot
pm2 status
pm2 restart meltem-bot
pm2 stop meltem-bot
pm2 monit
```

---

## Alternative: rsync (no archive)

**From local:**
```bash
rsync -avz --exclude=node_modules --exclude=dist --exclude=.git --exclude=src --exclude=public c:\Users\yilma\meltem-altintas-pro\ root@89.167.50.117:/opt/meltem-bot/
```

Then on server: `cd /opt/meltem-bot && npm install && npx playwright install chromium`
