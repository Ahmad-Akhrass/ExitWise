# Exitwise

A private Microsoft 365 employee offboarding automation application based on the supplied checklist. Each role, group membership and direct license removal requires its own additional approval. There is no demo mode: every case works against the connected Microsoft 365 tenant. Records are persisted in D1 and isolated by authenticated Site user.

## Workflow

1. Create a case with the exact employee UPN, change ticket, effective time, handover owner and preservation decisions.
2. Discover the account and review the decision checklist. Unknown investigation, legal hold or retention answers block approval.
3. Approve the exact target and snapshot. A live plan additionally requires typing the exact target UPN; discovery must be less than one hour old at approval.
4. Run the automation. It blocks sign-in and revokes sessions, then requests separate approval for each discovered direct active Entra role removal. The review shows the employee, target object, resource name, resource ID and intended effect.
5. The automation pauses for Exchange/Purview preservation evidence and OneDrive handover evidence.
6. Resume supported cloud group cleanup and eligible direct license release. Each group membership and license assignment is reviewed and approved individually before its removal. There is no bulk removal approval. Declining a removal keeps the item and records a required exception reason. Dynamic, synchronized, role-assignable and license-bearing groups are reserved for administrator review. Investigation, legal hold or retention requirements keep all licenses.
7. Complete a final administrator review covering PIM eligibility, inherited access, apps, shared resources, remaining groups/licenses and hybrid sources. Resolve or document approved exceptions.
8. Resume to close the case and download the text or JSON audit record.

The automation and workflow helper are deterministic. They follow recorded case state and rules; they do not use a language model or infer legal/compliance decisions. Plan approval covers the case scope, followed by a separate approval gate for each removal. Individual removal approvals expire after 15 minutes and are consumed by one attempt. A failed, interrupted or expired removal needs a fresh approval before retrying. Future-dated cases must be started by an operator after their effective time. Closing the browser stops orchestration between actions; reopening the case allows resumption.

## Live connector

Use **Connections → Environment editor** to enter the Microsoft tenant GUID, client GUID, secret Value, operator allowlist, protected UPNs and live-change switch. Save, test the saved connection, then run a live inactive-account scan. Keep live changes off while testing reports. Initial server environment values remain supported as defaults; editor settings override those six Microsoft keys immediately for new requests. Never put secrets in client code, the hosting manifest or Git.

| Variable | Purpose |
| --- | --- |
| `MS_TENANT_ID` | Single-tenant Entra directory GUID |
| `MS_CLIENT_ID` | Registered application client ID |
| `MS_CLIENT_SECRET` | Application secret value; configure as a hosted secret |
| `OFFBOARDING_ADMIN_EMAILS` | Comma-separated allowlist of authenticated Site operator emails |
| `OFFBOARDING_LIVE_ENABLED` | Explicitly `true` to enable live cases |
| `OFFBOARDING_PROTECTED_USERS` | Optional comma-separated protected UPNs |

The editor is restricted by the host-controlled `EXITWISE_CONFIG_ADMINS` email allowlist, independently of the editable operator list. `EXITWISE_CONFIG_KEY` is a base64-encoded 32-byte hosted secret used for AES-256-GCM encryption. The complete saved configuration is encrypted in the database; the key stays in the server environment. The client secret is write-only: blank preserves it, replacement changes it, and explicit clearing removes it. API snapshots show only whether a secret exists. Revision checks prevent stale saves. Saved configuration is shared by this installation; cases and reports remain isolated by user. The original key must be preserved with backups.

All allowlisted operators are protected from offboarding. If your Microsoft administrator UPN differs from your workspace email, add that UPN to protected accounts. Microsoft tokens remain server-side.

The Connections screen documents required Graph application permissions: `User.Read.All`, `Group.Read.All`, `User.EnableDisableAccount.All`, `User.RevokeSessions.All`, `GroupMember.ReadWrite.All`, `RoleManagement.ReadWrite.Directory`, and `LicenseAssignment.ReadWrite.All`. Tenant admin consent and, for sensitive account changes, appropriate directory role assignment are required. Test in a dedicated tenant before operating on employee accounts.

Live automation supports tenant member accounts and the approved direct Entra scope. It does not automatically convert mailboxes, apply Purview holds, copy OneDrive files, remove PIM eligibility, remove Azure RBAC, remove all app assignments, change the on-premises source, delete accounts, or wipe devices. These boundaries are explicit in handover steps and reports. A recorded administrator attestation is evidence supplied by the operator, not independently verified service proof. Revocation acceptance does not guarantee immediate termination of all service access tokens or application sessions.

Each execution step obtains a persisted compare-and-swap lock before external mutations. Stale revisions are rejected. Service calls use bounded timeouts and an 80-second step budget; interrupted actions require a service-state inspection record after two minutes before unlocking. Retries re-read current service state for idempotent operations. New roles, groups or licenses discovered after approval stop the relevant cleanup action. Group membership deletion always uses `/$ref`.

## Development and verification

Uses the provided Vinext/React Sites starter, TypeScript, Cloudflare Workers and D1. `.openai/hosting.json` retains the registered Site identity. Drizzle schema migrations are committed under `drizzle/` and are applied by Sites deployment.

```sh
node node_modules/typescript/bin/tsc --noEmit
node scripts/check-workflows.mjs
node scripts/check-inactivity.mjs
node scripts/check-environment.mjs
# Hosted build: use the installed Sites build helper.
# Docker/Node build:
node docker/build.mjs
```

The workflow checks run the actual route, store and automation modules against an in-memory SQLite implementation of the D1 contract, using the committed migration. Microsoft HTTP calls are mocked. They cover authorization, owner isolation, plan and per-item approval gates, stale and reused approvals, approval expiry, failed retries, declines, revision conflicts, preservation, pause/resume execution, concurrent starts, protected accounts and live target identity. Mocked live calls verify that each DELETE or license release affects only one specifically approved item. No real tenant mutation was executed during development. The environment checks also cover encrypted storage, administrator access, same-origin writes, secret replacement/removal, cookie authentication, login limits, SQLite transactions and migration persistence. See DOCKER.md for the standalone runtime and verification limits.

## Microsoft references

- [Former employee offboarding and data preservation](https://learn.microsoft.com/en-us/microsoft-365/admin/add-users/remove-former-employee?view=o365-worldwide)
- [Update accountEnabled and permission requirements](https://learn.microsoft.com/en-us/graph/api/user-update?view=graph-rest-1.0)
- [Session revocation behavior](https://learn.microsoft.com/en-us/graph/api/user-revokesigninsessions?view=graph-rest-1.0)
- [Remove group membership with $ref](https://learn.microsoft.com/en-us/graph/api/group-delete-members?view=graph-rest-1.0)
- [Remove direct role assignments](https://learn.microsoft.com/en-us/graph/api/unifiedroleassignment-delete?view=graph-rest-1.0)
- [Assign and remove licenses](https://learn.microsoft.com/en-us/graph/api/user-assignlicense?view=graph-rest-1.0)

## Inactive licensed-account report

Open **Inactive accounts**, choose a threshold (90 days by default; 30/60/90/180 presets or 1–3650 custom days) and run a scan of the connected tenant. The report retains the latest completed snapshot for each owner. It shows the last successful sign-in, days inactive, assigned products, assignment states/sources and enabled/disabled account status. Search, account/license filters, unknown-history results and CSV export are available. Scanning never creates an offboarding case or removes a license.

Inactivity uses `signInActivity.lastSuccessfulSignInDateTime`, which includes both interactive and non-interactive successes. Recent failed attempts do not reset inactivity. A missing or invalid successful-sign-in timestamp is listed as **Unknown history**, never inferred as “never signed in” or confirmed inactivity. Recent successful accounts and unlicensed accounts are excluded from review rows; guests are optional. The default license filter includes `Active` and `ActiveWithError` assignments, with the latter explicitly labeled **Partial**. Choose **All assigned** to review unverified, disabled or errored assignments. A missing assignment source/state is not represented as active.

Live scans require server credentials, an allowlisted operator, admin consent for Graph application permissions `User.Read.All` and `AuditLog.Read.All`, and the Microsoft Entra ID P1/P2 eligibility required for sign-in activity. Live mutations can remain disabled. `LicenseAssignment.Read.All` enables an optional subscribed-product lookup; inaccessible product names fall back to known names or SKU IDs with a warning. Sign-in activity may lag by up to 24 hours. All Graph pages must load successfully before a completed report is saved. Permission errors, partial pages, size-limit errors and failed scans preserve the previous successful report.

References: [Microsoft sign-in activity resource](https://learn.microsoft.com/en-us/graph/api/resources/signinactivity?view=graph-rest-1.0), [inactive-account reporting prerequisites](https://learn.microsoft.com/en-us/entra/identity/monitoring-health/howto-manage-inactive-user-accounts), [license assignment state](https://learn.microsoft.com/en-us/graph/api/resources/licenseassignmentstate?view=graph-rest-1.0).

## Docker deployment

The complete app can run independently using Docker Compose, a Node.js server and persistent SQLite storage. See [DOCKER.md](DOCKER.md) for setup, environment editing, backup and deployment instructions. Docker uses its own administrator login and ignores hosted ChatGPT identity headers. Hosted Sites continue to use the existing ChatGPT authentication and D1 database. The two deployments have separate data.
