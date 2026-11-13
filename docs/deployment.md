# Docker/VPS deployment

This guide runs NANA as a standalone Next.js container with a private,
authenticated Redis service. It does not publish Redis or deploy the app to a
public host automatically.

## Prerequisites

- A Linux VPS with Docker Engine and Docker Compose v2.
- A DNS name pointed at the VPS.
- An HTTPS reverse proxy such as Caddy or Nginx running on the host.
- Firewall rules that expose only SSH and the proxy's HTTP/HTTPS ports. Port
  3000 remains bound to loopback and Redis has no host port.

## Configure the environment

Create a deployment-only environment file from the template:

```bash
cp .env.example .env
chmod 600 .env
```

Set `APP_ORIGIN` to the exact public HTTPS origin, with no trailing slash. A
different scheme, hostname, or port causes mutation requests to fail closed.

Generate a unique Redis password rather than using the example value:

```bash
openssl rand -hex 48
```

Put the result in `REDIS_PASSWORD`. Do not paste it into issue trackers, shell
history, logs, or committed files. The application receives the corresponding
Redis URL only inside the private Compose network.

Keep `TRUSTED_PROXY_HOPS=0` unless the reverse proxy is administered with this
deployment and replaces the incoming client-IP header. If that trust boundary
is deliberately enabled, set the exact hop count and configure the proxy to
discard client-supplied forwarding headers before writing its own.

## Reverse proxy

Terminate TLS at the host proxy and forward requests to
`http://127.0.0.1:3000`. Preserve the original `Host` header and support
streaming responses. Redirect HTTP to HTTPS. Example Caddy configuration:

```caddyfile
nana.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

The production session cookie is `Secure`, so direct HTTP access is not a
supported production configuration.

## Launch and readiness

Validate the resolved Compose model before starting it:

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

The app waits for Redis to become healthy. The app health check calls
`/api/health`, which returns only `{"status":"ok"}` after a bounded Redis
PING. Redis failures return a generic 503 without connection details.

Check readiness locally on the VPS:

```bash
curl --fail --silent http://127.0.0.1:3000/api/health
docker compose logs --tail=100 app redis
```

Do not publish port 3000 in the firewall and do not add a Redis `ports` entry.

## Updates

Back up the Redis volume before risky changes, fetch the reviewed revision,
then rebuild and replace the containers:

```bash
docker compose down
docker run --rm \
  -v nana-card-game_redis-data:/data:ro \
  -v "$PWD/backups:/backup" \
  redis:8.10.3-alpine \
  sh -c 'tar -czf /backup/redis-data.tgz -C /data .'
git pull --ff-only
docker compose up -d --build
docker compose ps
```

Room and session records expire; the named Redis volume preserves active data
across normal container replacement, but it is not a substitute for backups.

## Rollback

Check out a previously reviewed commit or release tag, then rebuild that exact
revision with the existing `.env` and volume:

```bash
git checkout <known-good-tag-or-commit>
docker compose up -d --build
```

Do not restore a Redis backup over a running Redis container. Stop the stack,
restore into the named volume, verify ownership and file integrity, and then
start the stack. Keep a copy of the current volume until the restored service
passes readiness and gameplay checks.

## Operational checks

- `docker compose ps` shows both services healthy.
- `docker compose exec app id` reports the unprivileged `nextjs` user.
- `curl -I https://your-origin.example` includes `X-Content-Type-Options`,
  `Referrer-Policy`, and `X-Frame-Options`, and omits `X-Powered-By`.
- `curl http://127.0.0.1:6379` fails because Redis is not host-published.
- A Redis outage makes `/api/health` return 503; recovery restores 200.
- Host, join, start, reveal, chat, and reload work with two separate browser
  sessions after every update.

The artwork remains attributed to the upstream project as described in the
README. Its stated non-commercial caveat is unchanged; this repository does
not grant additional rights to third-party images.
