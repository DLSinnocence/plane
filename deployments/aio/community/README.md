# Plane Community All-In-One (AIO)

Deploy the complete stack with only `docker-compose.yml` and `.env`. Docker Compose
loads `.env` automatically; no initialization script, `-f` argument, or other
configuration file is needed.

Plane's web app, admin, spaces, API, workers, live server, and Caddy proxy run in
one AIO container. PostgreSQL, Redis-compatible Valkey, RabbitMQ, and MinIO run
alongside it on a Docker **bridge** network. Host networking is not used. Only one
AIO HTTP port is published (host 8080 to container 80); an external reverse proxy
handles HTTPS. Infrastructure ports remain inside the network.

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

Open `http://localhost:8080` for the default local installation. For a remote host,
replace `DOMAIN_NAME` and `WEB_URL` with its real IP address or domain before
starting. For HTTPS, use the reverse-proxy configuration below.

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

The source Compose file defaults to `ghcr.io/dlsinnocence/plane-aio-community:preview`.
This is a rolling preview image, not a stable release. Release downloads use the
publishing repository owner's namespace and pin the release version in both files.

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
- `LISTEN_HTTP_PORT`: The only published host port, default 8080, mapped to AIO HTTP
  port 80. Host ports 80 and 443 remain available for the reverse proxy.
- `APP_RELEASE`: Image version. Releases set this to their version; source defaults
  to `preview`.
- `FILE_SIZE_LIMIT`: Maximum upload size in bytes, default 5242880.
- `GUNICORN_WORKERS`: API worker count, default 1.

For direct HTTP on port 8080, set `DOMAIN_NAME=192.168.1.10`,
`WEB_URL=http://192.168.1.10:8080`, and `LISTEN_HTTP_PORT=8080`.

For an external HTTPS-terminating reverse proxy, use:

```dotenv
DOMAIN_NAME=plane.example.com
WEB_URL=https://plane.example.com
APP_PROTOCOL=https
SITE_ADDRESS=:80
LISTEN_HTTP_PORT=8080
MINIO_ENDPOINT_SSL=1
```

Forward the domain to `http://<deployment-host>:8080`. A proxy running directly on
the same host can use `http://127.0.0.1:8080`; a containerized proxy needs a reachable
host address, or `http://plane:80` if explicitly joined to the Compose network.
The proxy owns the HTTPS certificate and public port 443; AIO continues to listen
on HTTP port 80 inside the container. No `LISTEN_HTTPS_PORT` setting is needed.
Restrict access to the published HTTP port to the reverse proxy as appropriate for
your network.

Preserve the original Host and X-Forwarded-Proto headers and enable WebSocket
forwarding. Bucket requests use the same public origin; do not expose MinIO or
rewrite the signed bucket paths.

## Admin Setup Stays on the Loading Screen

Open `/god-mode/` with the trailing slash. The admin router uses `/god-mode/` as
its base path; older AIO proxy configurations serve `/god-mode` without redirecting,
which leaves the initial loading screen visible when clicking **Get started**.
Updated AIO images redirect the entry URL and preserve its query parameters.

For an existing deployment behind Nginx or OpenResty, add this exact-match location
inside the site's `server` block, validate the configuration, and reload the proxy:

```nginx
location = /god-mode {
    return 308 /god-mode/$is_args$args;
}
```

Opening `/god-mode/` directly works without changing the deployment. Editing the
repository template affects newly built AIO images; it does not update a running
container or an already published image.

## MeowAlive Authentication

MeowAlive authentication uses the Casdoor OIDC service at `https://sso.meowalive.com`.
Configure it in **God mode > Authentication > MeowAlive 验证** after deploying an image
containing this integration. See [MeowAlive setup](./MEOWALIVE.md) for the exact
callback URLs, Casdoor settings, optional environment variables, and verification.

## Language and Timezone Defaults

New user profiles default to Simplified Chinese (`zh-CN`) and new users use
Beijing time (`Asia/Shanghai`, UTC+08:00). A fresh browser also starts in Simplified
Chinese. Existing account preferences and saved browser language choices remain
in effect; the upgrade does not overwrite them.

New workspaces and cycles default to `Asia/Shanghai`. Projects inherit their
workspace's timezone when no project timezone is supplied. Existing workspaces,
projects, and cycles keep their saved timezones, and explicit timezone choices
continue to take precedence.

To change an existing account, open **Profile settings > Preferences > Language &
Time** (`/settings/profile/preferences`). Workspace administrators can change the
workspace timezone under **Workspace settings > General**. Django continues to
store and process timezone-aware timestamps in UTC; no container `TZ` override
is required for these application defaults.

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

Pushes to `preview` and `canary` automatically build and publish the AIO image
alongside the component images, using the matching branch tag. These push builds
use `linux/amd64`. To build ARM64 as well, run **Branch Build CE** manually with
`build_type=Build`, `aio_build=true`, and `arm64=true`. Manual Build runs continue
to respect the `aio_build` checkbox; Release runs always include AIO.

After **Build-Push AIO Docker Image** and **Merge AIO Manifest** succeed, update
an existing deployment with `docker compose up -d --pull always plane`. Publishing
a new image does not replace containers already running on your server.

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
