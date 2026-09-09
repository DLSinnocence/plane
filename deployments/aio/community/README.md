# Plane Community All-In-One (AIO) Docker Image

The Plane Community All-In-One Docker image packages all Plane services into a single container for easy deployment and testing. This image includes web interface, API server, background workers, live server, and more.

## What's Included

The AIO image contains the following services:

- **Web App** (Port 3001): Main Plane web interface
- **Space** (Port 3002): Public project spaces
- **Admin** (Port 3003): Administrative interface  
- **API Server** (Port 3004): Backend API
- **Live Server** (Port 3005): Real-time collaboration
- **Proxy** (Port 80, 443): Caddy reverse proxy
- **Worker & Beat**: Background task processing

## Prerequisites

### Required External Services

The AIO application image needs the services below. The complete bridge-network
Compose stack provisions them automatically; only the single-service Compose
variant requires you to provide them separately:

- **PostgreSQL Database**: For data storage
- **Redis**: For caching and session management  
- **RabbitMQ**: For message queuing
- **S3-Compatible Storage**: For file uploads (AWS S3 or MinIO)

### Required Environment Variables

You must provide these environment variables:

#### Core Configuration

- `DOMAIN_NAME`: Your domain name or IP address
- `DATABASE_URL`: PostgreSQL connection string
- `REDIS_URL`: Redis connection string  
- `AMQP_URL`: RabbitMQ connection string

#### Storage Configuration

- `AWS_REGION`: AWS region (e.g., us-east-1)
- `AWS_ACCESS_KEY_ID`: S3 access key
- `AWS_SECRET_ACCESS_KEY`: S3 secret key
- `AWS_S3_BUCKET_NAME`: S3 bucket name
- `AWS_S3_ENDPOINT_URL`: S3 endpoint (optional, defaults to AWS)

## Publishing to GHCR

The `Branch Build CE` workflow publishes images to
`ghcr.io/<lowercase-github-owner>/plane-aio-community`. For this repository, the
address is `ghcr.io/dlsinnocence/plane-aio-community`. Forks automatically use their
own owner. Component images and per-architecture build caches use the same GHCR
namespace.

CI authenticates with the built-in `GITHUB_TOKEN` and `packages: write`; no
`DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`, or separate publishing PAT is needed.
Images include an OCI source label connecting the package to this repository.
If a package already exists, grant this repository Actions access in its package
settings. Organization policy must permit package creation and publishing.

1. Commit and push the release changes to GitHub.
2. Open **Actions > Branch Build CE > Run workflow**, select the release branch,
   choose `build_type=Release`, and enter an unused version such as `v1.4.3`.
3. Leave `isPrerelease` unchecked for a formal release. AIO and both native
   architectures are enabled automatically. For a prerelease, use a version such
   as `v1.4.3-rc-1`, enable `isPrerelease`, and select `arm64` when needed.
4. Wait for **Publish AIO Release** to finish. Formal releases publish the version
   tag and `stable`; prereleases publish only the version tag.

New GHCR packages are private by default, even for public source repositories.
To allow anonymous pulls, open the AIO package's **Package settings** and change
its visibility to **Public**. This workflow does not change package visibility.
For private packages, authenticate on the deployment host before pulling:

```bash
printf '%s' "$GHCR_READ_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

Use a personal access token (classic) with `read:packages` and permission to access
the package; authorize SSO when required by your organization. This pull token is
only needed on the deployment host, not for publishing from Actions.

See [GitHub's Container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Quick Start

### Complete Stack (Bridge Network)

Download `docker-compose.full.yml`, `init-stack.sh`, and `README.md` from the same
release into one directory. The source files in `deployments/aio/community` also
work once the AIO image has been published to GHCR. Use Docker Compose v2 and
OpenSSL on the deployment host.

```bash
bash init-stack.sh
# For remote access, edit DOMAIN_NAME and WEB_URL in .env before starting.
docker compose -f docker-compose.full.yml pull
docker compose -f docker-compose.full.yml up -d
```

Open `http://localhost` for a local installation. For remote access, set
`DOMAIN_NAME` to the server IP or domain (without a port) and `WEB_URL` to its full
public origin. For example, when `LISTEN_HTTP_PORT=8080`, set
`WEB_URL=http://192.168.1.10:8080` and `DOMAIN_NAME=192.168.1.10`. For HTTPS, set
`APP_PROTOCOL=https`, `WEB_URL=https://your-domain.com`, and
`SITE_ADDRESS=your-domain.com`. Behind an external HTTPS-terminating proxy, leave
`SITE_ADDRESS=:80` and set `MINIO_ENDPOINT_SSL=1` as well. Preserve the original
Host and X-Forwarded-Proto headers in that proxy.

The complete stack runs one AIO application container plus PostgreSQL,
Redis-compatible Valkey, RabbitMQ, and MinIO. A short-lived `minio-init` service
waits for storage and creates a private uploads bucket. AIO waits for the database,
cache, message queue, and bucket initialization before starting its own migrations.
An exited `minio-init` container with exit code 0 is normal.

All services use a Docker **bridge** network and internal DNS service names.
There is no host networking. Only AIO HTTP/HTTPS ports are published; database,
cache, queue, MinIO API, and MinIO console ports are not exposed on the host.
Uploads and downloads use the same public AIO origin through the Caddy proxy.

`init-stack.sh` generates five independent random credentials in `.env` with mode
`0600`, and refuses to overwrite an existing file. Keep and back up that file.
Database, queue, cache, uploads, application data, and Caddy certificates use named
volumes. Do not run `down -v` unless you intend to delete the deployment's data.
When upgrading, retain `.env` and the Compose project directory/name:

```bash
APP_RELEASE=vX.Y.Z docker compose -f docker-compose.full.yml pull
APP_RELEASE=vX.Y.Z docker compose -f docker-compose.full.yml up -d
docker compose -f docker-compose.full.yml ps -a
```

Use a release containing the bridge-stack changes; older AIO images do not honor
its MinIO mode and public URL configuration. Do not run both Compose variants in
the same project at once.

### Existing External Services

Alternatively, download `docker-compose.yml`, `variables.env`, and `README.md`.
This Compose variant runs only the AIO application and needs existing PostgreSQL,
Redis, RabbitMQ, and S3-compatible storage.

1. Set `DOMAIN_NAME`, the database, Redis, and RabbitMQ URLs, and the S3 settings in
   `variables.env`. Use service addresses reachable from the container, not
   `localhost`.
2. Set persistent `SECRET_KEY` and `LIVE_SERVER_SECRET_KEY` values in
   `variables.env`. Generate each with `openssl rand -hex 32`. Automatically
   generated keys do not survive container recreation.
3. Start Plane:

   ```bash
   docker compose pull
   docker compose up -d
   ```

The default HTTP endpoint is `http://<DOMAIN_NAME>`. Set `WEB_URL` and
`CORS_ALLOWED_ORIGINS` explicitly when using a nondefault public port. For HTTPS,
configure `SITE_ADDRESS` and `APP_PROTOCOL=https`. Caddy certificate and
configuration data are persisted in the `plane_data` volume. Keep `variables.env`
private and reuse it for upgrades. The `APP_RELEASE` in `variables.env` is a
container setting, not a Compose interpolation source; use a shell override to
select another image tag.

Both release Compose files are pinned to the AIO image for that release. Formal
releases include `linux/amd64` and `linux/arm64`; prereleases include `linux/amd64`
and optionally `linux/arm64`. Publication waits for the AIO image manifest to
succeed. Component images remain build dependencies, but releases no longer
include the legacy multi-container CLI installer, restore scripts, or Swarm
assets. Existing releases are not modified automatically.

### Basic Usage

```bash
docker run --name plane-aio --rm -it \
    -p 80:80 \
    -e DOMAIN_NAME=your-domain.com \
    -e DATABASE_URL=postgresql://user:pass@host:port/database \
    -e REDIS_URL=redis://host:port \
    -e AMQP_URL=amqp://user:pass@host:port/vhost \
    -e AWS_REGION=us-east-1 \
    -e AWS_ACCESS_KEY_ID=your-access-key \
    -e AWS_SECRET_ACCESS_KEY=your-secret-key \
    -e AWS_S3_BUCKET_NAME=your-bucket \
    ghcr.io/dlsinnocence/plane-aio-community:stable
```

### Example with IP Address

```bash
MYIP=192.168.68.169
docker run --name myaio --rm -it \
    -p 80:80 \
    -e DOMAIN_NAME=${MYIP} \
    -e DATABASE_URL=postgresql://plane:plane@${MYIP}:15432/plane \
    -e REDIS_URL=redis://${MYIP}:16379 \
    -e AMQP_URL=amqp://plane:plane@${MYIP}:15673/plane \
    -e AWS_REGION=us-east-1 \
    -e AWS_ACCESS_KEY_ID=5MV45J9NF5TEFZWYCRAX \
    -e AWS_SECRET_ACCESS_KEY=7xMqAiAHsf2UUjMH+EwICXlyJL9TO30m8leEaDsL \
    -e AWS_S3_BUCKET_NAME=plane-app \
    -e AWS_S3_ENDPOINT_URL=http://${MYIP}:19000 \
    -e FILE_SIZE_LIMIT=10485760 \
    ghcr.io/dlsinnocence/plane-aio-community:stable
```

## Configuration Options

### Optional Environment Variables

#### Network & Protocol

- `SITE_ADDRESS`: Server bind address (default: `:80`)


#### Security & Secrets

- `SECRET_KEY`: Django secret key (auto-generated if not supplied; set explicitly for production)
- `LIVE_SERVER_SECRET_KEY`: Live server secret (auto-generated if not supplied; set explicitly for production)

#### File Handling

- `FILE_SIZE_LIMIT`: Maximum file upload size in bytes (default: `5242880` = 5MB)

#### API Configuration

- `API_KEY_RATE_LIMIT`: API key rate limit (default: `60/minute`)

## Port Mapping

The following ports are exposed:

- `80`: Main web interface (HTTP)
- `443`: HTTPS (if SSL configured)

## Volume Mounts

### Recommended Persistent Volumes

```bash
-v /path/to/logs:/app/logs \
-v /path/to/data:/app/data 
```

## Building the Image

The preparation script generates `dist/plane.env`, `dist/Caddyfile`, and the
versioned deployment files in `dist/release/`. It prints the Docker build command;
it does not build or push an image itself.

```bash
cd deployments/aio/community
IMAGE_NAMESPACE=ghcr.io/dlsinnocence bash ./build.sh --release=v1.4.3
docker build -t ghcr.io/dlsinnocence/plane-aio-community:v1.4.3 \
  --build-arg IMAGE_NAMESPACE=ghcr.io/dlsinnocence \
  --build-arg PLANE_VERSION=v1.4.3 .
```

Available preparation options:

- `--release`: Plane version to prepare (required)
- `--image-name`: Output image used in the generated Compose file and printed build command
- `IMAGE_NAMESPACE`: Registry and owner of the component images; also supplies the default output image prefix

The Dockerfile and preparation script retain `makeplane` as the local default
for compatibility with existing Docker Hub builds. CI always overrides it with
the current repository owner's GHCR namespace. The downloaded release Compose
file already contains that namespace; no manual image-address edit is needed.

The Docker build requires the six component images for the same version to be
available in the registry. CI retains their native per-architecture builds and
manifest merges before assembling AIO.

Run the release asset regression tests from the repository root:

```bash
node --test deployments/aio/community/tests/*.test.mjs
```

Compose configuration tests require Docker Compose (no daemon is needed). They
are skipped locally when it is unavailable and required on GitHub Actions. Set
`COMPOSE_BINARY` to a standalone Compose executable when not using the Docker CLI.

## Troubleshooting

### Logs

All service logs are available in `/app/logs/`:

- Access logs: `/app/logs/access/`
- Error logs: `/app/logs/error/`

### Health Checks

The container runs multiple services managed by Supervisor. Check service status:

```bash
docker exec -it <container-name> supervisorctl status
```

### Common Issues

1. **Database Connection Failed**: Ensure PostgreSQL is accessible and credentials are correct
2. **Redis Connection Failed**: Verify Redis server is running and URL is correct  
3. **File Upload Issues**: Check S3 credentials and bucket permissions

### Environment Validation

The container will validate required environment variables on startup and display helpful error messages if any are missing.

## Production Considerations

- Use proper SSL certificates for HTTPS
- Configure proper backup strategies for data
- Monitor resource usage and scale accordingly
- Use external load balancer for high availability
- Regularly update to latest versions
- Secure your environment variables and secrets

## Support

For issues and support, please refer to the official Plane documentation.
