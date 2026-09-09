# Plane Community All-In-One (AIO)

Deploy the complete stack with only `docker-compose.yml` and `.env`. Docker Compose
loads `.env` automatically; no initialization script, `-f` argument, or other
configuration file is needed.

Plane's web app, admin, spaces, API, workers, live server, and Caddy proxy run in
one AIO container. PostgreSQL, Redis-compatible Valkey, RabbitMQ, and MinIO run
alongside it on a Docker **bridge** network. Host networking is not used. Only the
AIO HTTP/HTTPS ports are published; infrastructure ports remain inside the network.

## Quick Start

Use Docker Compose v2 and an AIO image published from a release containing these
deployment changes.

### From a Release

1. Download `docker-compose.yml` and `.env` from the same GitHub Release into one
   directory. Keep the leading dot in the `.env` filename.
2. Edit `.env`: set `DOMAIN_NAME`, `WEB_URL`, and all five blank credentials below.
3. Run in that directory:

   ```bash
   docker compose up -d
   ```

Open `http://localhost` for the default local installation. For a remote host,
replace `DOMAIN_NAME` and `WEB_URL` with its real IP address or domain before
starting.

### From the Source Checkout

The repository tracks the blank template as `.env.example` so a configured `.env`
is never committed. Copy it once, fill in the values, and run the same command:

```bash
cd deployments/aio/community
cp -n .env.example .env
# Edit .env before starting. Do not overwrite an existing installation's .env.
chmod 600 .env
docker compose up -d
```

The source Compose file defaults to `ghcr.io/dlsinnocence/plane-aio-community:stable`.
Release downloads use the publishing repository owner's namespace and pin the
release version in both files.

## Environment Configuration

Fill in these five required values with independent randomly generated strings:

| Variable                 | Purpose                   |
| ------------------------ | ------------------------- |
| `POSTGRES_PASSWORD`      | PostgreSQL password       |
| `RABBITMQ_PASSWORD`      | Message queue password    |
| `MINIO_ROOT_PASSWORD`    | Object storage password   |
| `SECRET_KEY`             | Django signing key        |
| `LIVE_SERVER_SECRET_KEY` | Live collaboration secret |

Use a password manager to generate at least 32 alphanumeric characters per value,
for example 64 hexadecimal characters. Database and queue passwords are embedded
in connection URLs, so avoid URL-special characters. Empty or missing values stop
Compose with an error. There are no shared default passwords. Protect `.env` with
private file permissions and retain it across upgrades; it contains all required
credentials and signing keys.

Connection URLs, usernames, the storage endpoint, and the uploads bucket are wired
inside Compose. You do not need to configure them separately.

### Public Address and Ports

- `DOMAIN_NAME`: Hostname or IP address without scheme or port.
- `WEB_URL`: Full public origin, including a nondefault port when used.
- `LISTEN_HTTP_PORT` / `LISTEN_HTTPS_PORT`: Host ports mapped to AIO, default 80/443.
- `APP_RELEASE`: Image version. Releases set this to their version; source defaults
  to `stable`.
- `FILE_SIZE_LIMIT`: Maximum upload size in bytes, default 5242880.
- `GUNICORN_WORKERS`: API worker count, default 1.

For example, HTTP on port 8080 requires `DOMAIN_NAME=192.168.1.10`,
`WEB_URL=http://192.168.1.10:8080`, and `LISTEN_HTTP_PORT=8080`.

For Caddy-managed HTTPS, set `APP_PROTOCOL=https`,
`WEB_URL=https://your-domain.com`, and `SITE_ADDRESS=your-domain.com`. Ensure DNS
and public ports 80/443 reach the server. Behind an external HTTPS-terminating
proxy, leave `SITE_ADDRESS=:80` and also set `MINIO_ENDPOINT_SSL=1`. Preserve the
original Host and X-Forwarded-Proto headers. Bucket requests use the same public
origin; do not expose MinIO or rewrite the signed bucket paths.

## Startup and Persistence

A short-lived `minio-init` service waits for storage and creates a private uploads
bucket. It is defined inside Compose, not an extra script to download. An exited
`minio-init` container with exit code 0 is normal. AIO waits for the database,
cache, message queue, and bucket initialization before starting its migrations.

Database, queue, cache, uploads, application data, logs, and Caddy certificates use
named volumes. Keep the Compose project directory/name stable when upgrading and
back up both the volumes and `.env`. Do not use `docker compose down -v` unless you
intend to delete the deployment's data.

```bash
docker compose ps -a
docker compose logs --tail=100 plane
```

## Upgrading

Keep your configured `.env`; do not replace it with the blank release attachment.
Update `APP_RELEASE` to the new version and replace the Compose file if needed:

```bash
docker compose pull
docker compose up -d
```

Existing deployments created with the previous full-stack manifest can reuse
their `.env` and named volumes. Place the new `docker-compose.yml` in the same
project directory and preserve its Compose project name. Runtime `variables.env`
is an image-build template, not a deployment input.

## Publishing to GHCR

In **Actions > Branch Build CE > Run workflow**, select the release branch,
choose `build_type=Release`, and enter an unused version such as `v1.4.3`.
Formal releases automatically build both native architectures and publish the
version tag plus `stable`. For a prerelease, enable `isPrerelease`, use a version
such as `v1.4.3-rc-1`, and select `arm64` when needed. Prereleases publish only the
version tag. AIO build and manifest verification must succeed before the Release
is created.

CI publishes to `ghcr.io/<lowercase-github-owner>/plane-aio-community` using the
built-in `GITHUB_TOKEN` with `packages: write`. No Docker Hub credentials or
separate publishing PAT are needed. Component images and build caches use the
same namespace. Images carry an OCI source label linking them to the repository;
existing packages may need this repository granted Actions access in their package
settings. Organization policy must allow package publishing.

New GHCR packages are private by default, even for public source repositories.
For anonymous pulls, change the AIO package's visibility to **Public** in
**Package settings**. The workflow does not change package visibility. For private
packages, log in on the deployment host with a personal access token (classic)
that has `read:packages` and access to the package:

```bash
printf '%s' "$GHCR_READ_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

Authorize SSO when your organization requires it. See
[GitHub's Container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Building and Testing

Deployment does not require `build.sh`. For image maintainers, it prepares
`dist/plane.env`, `dist/Caddyfile`, and exactly two release files:
`dist/release/docker-compose.yml` and `dist/release/.env`. Deployment credentials
are copied from the blank `.env.example`, never from a configured local `.env`.

```bash
cd deployments/aio/community
IMAGE_NAMESPACE=ghcr.io/dlsinnocence bash ./build.sh --release=v1.4.3
docker build -t ghcr.io/dlsinnocence/plane-aio-community:v1.4.3 \
  --build-arg IMAGE_NAMESPACE=ghcr.io/dlsinnocence \
  --build-arg PLANE_VERSION=v1.4.3 .
```

The six component images for the same version must already exist in that
namespace. `IMAGE_NAMESPACE` sets the component prefix and default output image;
`--image-name` overrides the output image. The Dockerfile and preparation script
retain `makeplane` as the local default for existing Docker Hub builds; CI always
passes the current owner's GHCR namespace.

From the repository root:

```bash
node --test .github/actions/tests/*.test.mjs deployments/aio/community/tests/*.test.mjs
```

Compose configuration tests need Docker Compose but not a daemon. They are skipped
locally if unavailable and required on GitHub Actions. Set `COMPOSE_BINARY` to use
a standalone Compose executable instead of `docker compose`.
