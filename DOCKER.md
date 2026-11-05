# Run Exitwise with Docker

This package contains the complete application source, Dockerfile, Compose configuration, database migrations and tests. It supports the offboarding workflow with individual removal approvals, inactive licensed-account reports, CSV/audit exports and the connection environment editor.

## 1. Configure the administrator

Install Docker Desktop (Windows/macOS) or Docker Engine with the Compose plugin (Linux), then extract this package and open a terminal in its root folder.

Copy `.env.example` to `.env`:

```sh
# macOS / Linux
cp .env.example .env
```

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

Edit `.env` and set:

```dotenv
EXITWISE_ADMIN_EMAIL=your-admin@example.com
EXITWISE_ADMIN_PASSWORD=YOUR_UNIQUE_PASSWORD
EXITWISE_PORT=3000
```

Use a unique password of at least 14 characters. The application rejects the example password. This Docker edition provides one administrator login; its email is also the configuration administrator. Microsoft account credentials are entered after sign-in.

## 2. Build and start

```sh
docker compose up --build -d
docker compose ps
```

Open **http://localhost:3000** and sign in with the administrator email and password from `.env`. The database migrations run automatically before the server starts. The workspace starts empty; connect Microsoft 365 under Connections before creating cases.

The default port binding accepts connections from this computer only. For remote hosting, put an HTTPS reverse proxy in front of the app, preserve the original Host header, and set `EXITWISE_PUBLIC_URL=https://your-exitwise-host.example.com` in `.env`. If the proxy runs in another container, connect it through a Docker network to `exitwise:3000`. If needed, remove the localhost port mapping and expose the service only on that network. Restart the service after changing `.env`:

```sh
docker compose up -d --force-recreate
```

## 3. Connect Microsoft 365

1. In Microsoft Entra admin center, register a single-tenant application. Copy its Directory (tenant) ID and Application (client) ID.
2. Create a client secret and retain the **Value**. Grant the Microsoft Graph **application permissions** required by the enabled features and obtain tenant admin consent. For inactive-account reporting, use `User.Read.All` and `AuditLog.Read.All`; Microsoft requires Entra ID P1/P2 for sign-in activity. `LicenseAssignment.Read.All` is optional for product-name lookup.
3. Open **Connections → Environment editor** in Exitwise. Enter the tenant GUID, client GUID, secret Value and operator email. The operator email must match your Docker administrator login. Add protected Microsoft account UPNs, including your Microsoft admin account if it differs from your Docker login email.
4. Leave **Enable live offboarding changes** off. Select **Save settings**, then **Test saved connection**.
5. Open **Inactive accounts**, choose **Live tenant**, set the inactivity threshold, and run the scan. The test connection verifies authentication/user discovery; the live scan additionally checks reporting access.
6. Enable live offboarding only after granting the additional action permissions shown in Connections and testing the workflow with a dedicated test account. Each individual role, supported group membership and direct license removal still requires a separate approval. No account deletion or device wipe is implemented.

Editor changes take effect for new requests immediately. A blank secret field retains the current secret. Use the explicit clear checkbox to remove it. A saved encrypted configuration overrides the corresponding `.env` Microsoft values. To change an existing connection, edit it in the app; changing `.env` alone will not replace saved editor values.

## Data and credentials

- The `exitwise-data` named volume contains the SQLite database, encrypted connection settings, `configuration.key` and `session.key`. Docker creates both random keys at first startup. Keep the volume across image upgrades.
- The complete connection configuration uses AES-256-GCM authenticated encryption; the secret is never returned to the browser. Configuration keys and session keys stay on the server and are not included in source or images.
- The container runs as the non-root `node` user. Administrator sessions last eight hours, use HTTP-only cookies, reject tampering and are rate-limited at login. HTTPS deployments set Secure cookies when `EXITWISE_PUBLIC_URL` is HTTPS. Browser writes require the expected Origin.
- Hosted ChatGPT identity headers are ignored in Docker. The hosted Site and Docker installation have separate databases. Existing hosted cases/reports and real tenant credentials are not bundled in this source package.
- `.env` is excluded from Git, Docker build context and downloadable source. To use mounted secrets, configure `EXITWISE_ADMIN_PASSWORD_FILE`, `MS_CLIENT_SECRET_FILE`, `EXITWISE_CONFIG_KEY_FILE` or `EXITWISE_SESSION_SECRET_FILE` instead of the corresponding direct value, and mount the referenced file read-only into the container.

## Back up and restore

Back up the entire data volume, including both key files. Stop the service first for a consistent snapshot. For example, with a project name of `exitwise`:

```sh
docker compose -p exitwise stop
docker run --rm -v exitwise_exitwise-data:/source:ro -v "${PWD}:/backup" busybox tar czf /backup/exitwise-backup.tar.gz -C /source .
docker compose -p exitwise start
```

If your project name differs, use the actual volume name from `docker volume ls`. Treat the backup as sensitive: it contains the decryption key alongside encrypted tenant credentials. Restore all files to the same volume before starting the service. Do not discard or regenerate `configuration.key` when keeping an existing database. Database migrations are checked against their original hashes and run once per version.

## Operations and tests

```sh
docker compose logs --tail=100 exitwise
docker compose down
# Start again with the existing data:
docker compose up -d
```

The health check calls `/api/health`; it checks the local database, not Microsoft permissions. Deleting the named volume deletes stored cases, reports, settings and keys. One container instance is intended per SQLite volume.

For source development with Node 24 and pnpm 11.25.0:

```sh
pnpm install --frozen-lockfile
pnpm test:workflow
pnpm test:inactivity
pnpm test:environment
pnpm build:docker
pnpm test:docker
```

The Docker/Node build uses Next.js standalone output. The original hosted build uses Vinext and Cloudflare D1. A server-only build replacement maps the Cloudflare binding import to the SQLite adapter in Docker; the same business rules and API routes serve both runtimes.

Verification: production builds and automated application/storage/authentication checks are run during preparation. `test:docker` runs the built standalone server with the same startup files as the Dockerfile and checks sign-in, authorization, credential persistence, workspace data and restart behavior. The current authoring environment has no Docker executable, so the container image itself must be built and checked on your Docker host. No real Microsoft tenant credentials or tenant mutations were used during verification.

References: [Next.js deployment](https://nextjs.org/docs/app/getting-started/deploying), [standalone output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output), [Microsoft reporting prerequisites](https://learn.microsoft.com/en-us/entra/identity/monitoring-health/howto-manage-inactive-user-accounts).
