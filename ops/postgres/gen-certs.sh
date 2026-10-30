#!/bin/sh
# Generates a local CA and a Postgres server certificate for the compose stack
# into ops/postgres/certs/ (gitignored). Run once before `docker compose up`.
# The server cert is valid for the compose hostname `postgres` and for
# localhost, so services can use sslmode=verify-full against the CA.
set -eu
cd "$(dirname "$0")"
mkdir -p certs
cd certs
[ -f server.crt ] && { echo "certs already exist in $(pwd); delete them to regenerate"; exit 0; }
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=filspay-local-ca" \
  -keyout ca.key -out ca.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=postgres" -keyout server.key -out server.csr 2>/dev/null
printf 'subjectAltName=DNS:postgres,DNS:localhost,IP:127.0.0.1\n' > san.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 \
  -extfile san.ext -out server.crt 2>/dev/null
rm -f server.csr san.ext ca.srl
chmod 644 ca.crt server.crt
echo "wrote $(pwd)/{ca.crt,server.crt,server.key}"
