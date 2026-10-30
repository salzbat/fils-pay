#!/bin/sh
# Self-signed TLS cert for the proxy on a local or demo box. On a real host,
# put the CA-issued fullchain.pem / privkey.pem in ops/nginx/tls instead
# (docs/HOSTING.md). Output is gitignored and excluded from image builds.
set -eu
cd "$(dirname "$0")"
mkdir -p tls
host="${1:-localhost}"
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -subj "/CN=${host}" -addext "subjectAltName=DNS:${host},DNS:localhost,IP:127.0.0.1" \
  -keyout tls/privkey.pem -out tls/fullchain.pem
chmod 600 tls/privkey.pem
echo "wrote ops/nginx/tls/{fullchain,privkey}.pem for ${host}"
