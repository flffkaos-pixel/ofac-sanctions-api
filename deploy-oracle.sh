#!/bin/bash
# Oracle Cloud Free Tier 배포 (Ubuntu 22.04/24.04)
set -e

echo "=== 1. 시스템 업데이트 ==="
sudo apt update && sudo apt upgrade -y

echo "=== 2. Node.js 24 설치 ==="
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v

echo "=== 3. 앱 설치 ==="
cd /opt
sudo git clone https://github.com/flffkaos-pixel/ofac-sanctions-api.git
sudo chown -R ubuntu:ubuntu ofac-sanctions-api
cd ofac-sanctions-api
npm install --production

echo "=== 4. 데이터 디렉토리 ==="
sudo mkdir -p /var/lib/ofac-api
sudo chown ubuntu:ubuntu /var/lib/ofac-api

echo "=== 5. systemd 서비스 ==="
sudo tee /etc/systemd/system/ofac-api.service > /dev/null <<'EOF'
[Unit]
Description=OFAC Sanctions API
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/ofac-sanctions-api
Environment=PORT=80
Environment=NODE_ENV=production
Environment=DATA_DIR=/var/lib/ofac-api
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now ofac-api

echo "=== 6. 방화벽 ==="
sudo ufw allow 80/tcp
sudo ufw allow 22/tcp
sudo ufw --force enable

echo "=== 7. 배포 완료! ==="
echo "IP: $(curl -s ifconfig.me)"
echo "접속: http://$(curl -s ifconfig.me)/"
echo ""
echo "로그 확인: sudo journalctl -u ofac-api -f"
