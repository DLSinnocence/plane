#!/usr/bin/env bash
set -euo pipefail

if [ -e .env ] || [ -L .env ]; then
  echo "Refusing to overwrite .env; keep existing credentials when upgrading." >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "OpenSSL is required to generate deployment credentials." >&2
  exit 1
fi

# Hex credentials are safe in URLs and Compose interpolation.
postgres_password=$(openssl rand -hex 32)
rabbitmq_password=$(openssl rand -hex 32)
minio_password=$(openssl rand -hex 32)
secret_key=$(openssl rand -hex 32)
live_secret_key=$(openssl rand -hex 32)

umask 077
set -o noclobber
{
  printf '%s\n' \
    'DOMAIN_NAME=localhost' \
    'WEB_URL=http://localhost' \
    'APP_PROTOCOL=http' \
    'SITE_ADDRESS=:80' \
    'LISTEN_HTTP_PORT=80' \
    'LISTEN_HTTPS_PORT=443' \
    'MINIO_ENDPOINT_SSL=0' \
    'FILE_SIZE_LIMIT=5242880' \
    'GUNICORN_WORKERS=1' \
    "POSTGRES_PASSWORD=$postgres_password" \
    "RABBITMQ_PASSWORD=$rabbitmq_password" \
    "MINIO_ROOT_PASSWORD=$minio_password" \
    "SECRET_KEY=$secret_key" \
    "LIVE_SERVER_SECRET_KEY=$live_secret_key"
} > .env

printf '%s\n' 'Created .env with private permissions. Set DOMAIN_NAME and WEB_URL before deploying to a remote host.'
