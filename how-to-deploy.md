# How to Deploy WhatsApp API with PM2 & Nginx

Panduan ini membantu Anda menjalankan proyek di domain `wapi-v1.chiefaiofficer.id` pada server Ubuntu 22.04+ menggunakan Node.js, PM2, dan Nginx (dengan TLS Let's Encrypt).

## 1. Prasyarat Server
- Ubuntu 22.04+ dengan akses sudo.
- Domain `wapi-v1.chiefaiofficer.id` sudah mengarah (A record) ke IP publik server.
- Firewall membuka port `22`, `80`, `443`.
- Terpasang Node.js 18 LTS, npm, git, dan Google Chrome/Chromium (dibutuhkan `whatsapp-web.js`).

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs git nginx chromium-browser
sudo npm install -g pm2
```

## 2. Menyiapkan Kode & Dependensi
```bash
sudo mkdir -p /opt/whatsapp-api
sudo chown $USER:$USER /opt/whatsapp-api
cd /opt/whatsapp-api
git clone <repo-anda> .
npm install --production
```

## 3. Konfigurasi Environment
Salin `.env.example` lalu sesuaikan:

```bash
cp .env.example .env
nano .env
```

Contoh isi minimal:
```dotenv
PORT=3000
APP_BASE_URL=https://wapi-v1.chiefaiofficer.id
AI_BACKEND_URL=https://ai.internal/api
CORS_ORIGINS=https://app.chiefaiofficer.id
TEMP_DIR=/opt/whatsapp-api/tmp
WWEBJS_AUTH_DIR=/opt/whatsapp-api/storage
DB_URL="postgresql://user:pass@host:5432/whatsapp"
LOG_LEVEL=info
```

Buat folder untuk penyimpanan lokal WhatsApp & file sementara:
```bash
mkdir -p tmp storage
```

## 4. Setup Database via Prisma
Pastikan koneksi PostgreSQL aktif.

```bash
npm run prisma:generate
npm run prisma:push        # atau `npm run prisma:migrate` sesuai preferensi
```

## 5. Menjalankan Aplikasi dengan PM2
1. Buat file `ecosystem.config.js`:
   ```bash
nano ecosystem.config.js
   ```
   ```js
   module.exports = {
     apps: [
       {
         name: "whatsapp-api",
         script: "app.js",
         cwd: "/opt/whatsapp-api",
         instances: 1,
         exec_mode: "fork",
         env: {
           NODE_ENV: "production",
           PORT: 3000
         },
         env_production: {
           NODE_ENV: "production"
         }
       }
     ]
   };
   ```
2. Mulai & simpan proses:
   ```bash
   pm2 start ecosystem.config.js --env production
   pm2 status
   pm2 save            # agar otomatis start saat reboot
   pm2 startup systemd # ikuti instruksi yang keluar
   ```

## 6. Konfigurasi Nginx (Reverse Proxy)
1. Buat blok server baru:
   ```bash
sudo nano /etc/nginx/sites-available/wapi-v1.chiefaiofficer.id
   ```
   ```nginx
   server {
     listen 80;
     listen [::]:80;
     server_name wapi-v1.chiefaiofficer.id;

     location / {
       proxy_pass http://127.0.0.1:3321;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
   }
   ```
2. Aktifkan site & cek sintaks:
   ```bash
sudo ln -s /etc/nginx/sites-available/wapi-v1.chiefaiofficer.id /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
   ```

## 7. Tambahkan TLS Let's Encrypt
Install Certbot dan dapatkan sertifikat:
```bash
sudo snap install core; sudo snap refresh core
sudo snap install --classic certbot
sudo ln -s /snap/bin/certbot /usr/bin/certbot
sudo certbot --nginx -d wapi-v1.chiefaiofficer.id
```

Certbot otomatis menambahkan blok HTTPS dan membuat cron renew. Verifikasi dengan:
```bash
sudo systemctl status certbot.timer
```

## 8. Uji Aplikasi
1. **Health check**: `curl -i https://wapi-v1.chiefaiofficer.id/health`
2. **Metrics**: `curl -i https://wapi-v1.chiefaiofficer.id/metrics`
3. **Session API**: gunakan contoh cURL di README dengan domain baru.

Jika butuh debug, gunakan:
```bash
pm2 logs whatsapp-api --lines 200
pm2 restart whatsapp-api
```

## 9. Maintenance & Update
1. Tarik perubahan terbaru:
   ```bash
   cd /opt/whatsapp-api
   git pull
   npm install --production
   npm run prisma:generate
   ```
2. Restart layanan:
   ```bash
   pm2 restart whatsapp-api
   ```
3. Pastikan log bersih dan endpoint utama merespons normal.

## 10. Tips Produksi
- Gunakan `LOG_LEVEL=info` untuk produksi, `debug` hanya saat investigasi.
- Monitor folder `storage` dan `tmp`; jadwalkan cleanup jika disk hampir penuh.
- Simpan backup `.env` dan `WWEBJS_AUTH_DIR` agar sesi WhatsApp tidak perlu re-scan saat migrasi server.
- Pertimbangkan menambahkan Alertmanager/Prometheus scrape ke endpoint `/metrics`.

Selesai! Aplikasi kini berjalan di `https://wapi-v1.chiefaiofficer.id` di belakang Nginx dengan supervisi PM2.
