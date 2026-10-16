#!/usr/bin/env bash
# 사설 CA + localhost 서버 인증서 생성 (Nginx TLS 실습용). 산출물은 nginx/tls/certs/ (git 제외)
set -euo pipefail
cd "$(dirname "$0")"
OPENSSL="${OPENSSL:-$(ls /opt/homebrew/opt/openssl@3/bin/openssl /usr/local/opt/openssl@3/bin/openssl 2>/dev/null | head -1 || true)}"
OPENSSL="${OPENSSL:-openssl}"
mkdir -p certs && cd certs
if [ ! -f ca.crt ]; then
  "$OPENSSL" req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 -subj "/CN=Study Local CA" -keyout ca.key -out ca.crt
fi
"$OPENSSL" req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,DNS:study.local,IP:127.0.0.1" -keyout server.key -out server.csr
"$OPENSSL" x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 90 -copy_extensions copy -out server.crt
rm -f server.csr
"$OPENSSL" x509 -in server.crt -noout -subject -issuer -dates -ext subjectAltName
echo "→ certs/ca.crt (신뢰 저장소에 넣을 CA), certs/server.crt + server.key (Nginx 용)"
