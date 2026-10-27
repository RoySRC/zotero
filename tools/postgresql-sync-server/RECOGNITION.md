# PDF Recognition Gateway

Current desktop builds run **EpiLib (on this device)** with a profile-local SQLite
cache. Existing EpiLib recognition selections migrate on startup. This mode does
not use this gateway, account authentication, or a remote recognition container.
See the independent engine repository's README for bundled build/cache details.
Shared remote metadata-repository functionality is not implemented yet.

The following describes the retained **legacy HTTP deployment** for older clients.
Recognition version 2 can run in a separate container. This server only authenticates
the user and forwards bounded requests with a private service credential. It does
not perform provider lookups, run GROBID, or store PDF extraction data.

The worker now lives in the separate `epilib-pdf-recognition-engine` repository.
For sibling local checkouts, see [the recognition service guide](../../../epilib-pdf-recognition-engine/README.md) for the full
architecture, beginner-oriented source map, API contracts, provider integration,
local GROBID settings, Crossref sample evaluation, deployment, and tests.

The desktop bundles generated assets from that repository without duplicating its
editable source. This gateway communicates with its deployed HTTP service. Backend
unit/regression/container tests run in the recognition repository; gateway
contract tests remain here (`node --test test/recognizer.test.mjs`).

## Gateway configuration

- `RECOGNITION_SERVICE_URL`: private worker base URL, such as
  `http://127.0.0.1:23130/` for a host process talking to the Compose worker.
- `RECOGNITION_SERVICE_KEY_FILE`: file containing the same random service secret
  mounted into the worker. Never reuse a user's API key or commit this file.

Keep the existing PostgreSQL connection and account authentication configuration.
Restart this service after setting the new worker configuration. In a Docker
network use the worker service hostname, not the container's own loopback address.

## Desktop server URL

In General Settings, select **EpiLib** under **PDF Recognition**. The **Server URL**
field is editable and saved automatically in `recognize.epilib.url`. It changes
recognition only, not the metadata sync URL or any library/file-storage setting.
Clear the field to follow Account Settings automatically; the resulting gateway
URL appears as the placeholder. For a metadata server at
`http://localhost:23129/`, this is `http://localhost:23129/recognizer/`.

The desktop appends `health` or `recognize` to this base URL. HTTP(S) URLs are
normalized with a trailing slash. Embedded credentials, queries, and fragments
are rejected. Merely editing the field never sends a request or uploads a PDF.

Only the exact account gateway receives the account session token, including
when that same URL is entered explicitly. A custom URL with another host, port,
scheme, or path receives anonymous requests, not account credentials. It must
therefore support anonymous access or use an independently authenticated proxy.
Redirects are never followed. A URL or authentication-scope change during PDF
extraction/token retrieval aborts the pending request.

Do **not** put the private worker URL (`http://127.0.0.1:23130/`) in the desktop
field for this deployment. The worker requires a separate service secret kept
on the server; an anonymous desktop request will receive an authentication
error. Keep that secret out of desktop preferences and URLs. The authenticated
gateway on port 23129 forwards to the worker on the user's behalf.

## Route behavior

- `/recognizer/health` checks the worker protocol through normal user authentication.
- `/recognizer/recognize` forwards PDF-worker JSON (at most 5 MB), not PDF files.
- `/recognizer/report` returns 501; document feedback is not retained.

The existing middleware verifies the PostgreSQL-backed session token before the
router runs. `req.authUser` is checked again as a defense against accidental router
reordering. Only the service key, JSON body, and method reach the worker; account
identity, client cookies, and the user's token do not. The worker URL is operator
configuration, never a value supplied by PDF contents or the client request.

Missing configuration returns 503. Unreachable/invalid worker replies return
sanitized errors; the gateway never falls back to Zotero or the former in-process
identifier extractor. The new desktop understands both the legacy version 1
response and the complete-record version 2 response during upgrades.
# Personal provider credentials

The desktop's General > PDF Recognition > Provider API Keys editor encrypts secrets
with Mozilla's OSKeyStore (macOS Keychain, Windows DPAPI, or Linux Secret Service)
before saving the ciphertext in its local login manager. Provider keys are scoped
to the recognition URL and account; paired WorldCat values are saved atomically. The
authenticated gateway forwards a request's `providerKeys` object to its configured
worker without storing it in PostgreSQL or merging it into shared server settings.
The updated worker removes this object before extraction, caching and response
generation; each request has isolated provider credentials. Health responses must
pass through `providerCredentials: 1` so older workers cannot silently ignore keys.

Use HTTPS between desktop and gateway except for loopback, and a trusted private
network or HTTPS between gateway and worker. Do not enable request-body logging
on proxies. Metadata account tokens, worker service keys, and provider API keys
are separate credentials and must never be substituted for one another.

## Desktop credential storage and migration

`Zotero.CredentialStore` is the shared persistence layer for provider API keys and
PostgreSQL account tokens. An encrypted, versioned envelope binds each secret to
its login realm and username. The OS protects the encryption key; the profile's
login database holds ciphertext, not an extra plaintext copy. The older NSS
login-database protection remains in place as well. API keys are not stored in
ordinary preferences, SQLite metadata caches, or shared repository records.

Account tokens have separate realms for each canonical server base URL (including
its path and port) and server-issued user ID. Login, registration, and password
changes save under the response's identity, never the previous local user.
Logging out removes only that account's token. Changing the URL does not transfer
an existing token to the new destination. Credentials are decrypted only when
needed; Settings presence checks do not unlock the keychain.

Migration is lazy on first use, so it does not unlock every stored account at
startup. The old global account token is pinned to the startup URL/user in a
nonsecret preference before Settings can change either. Before migration, the
client confirms `/keys/current` at that original server returns the same user ID.
If the identity is unknown, mismatched, or the server is offline, the legacy entry
is preserved and a fresh login (or retry after reconnecting) is required. A token
is never tried against other servers to discover where it belongs. Existing
provider-key entries retain their original URL/user scope.

The sequence is encrypt, verify, persist, read back and verify, then remove the
legacy entry. Failed persistence restores the previous encrypted entry; failed
migration leaves the legacy source available for retry. Interrupted cleanup is
resumed on the next read. Pending operations are invalidated by logout or account
changes so a late keychain unlock cannot overwrite or resurrect credentials.
There is no plaintext fallback when OS storage is unavailable. A locked keychain
must be unlocked; a profile copied to another machine/OS account may require
logging in and re-entering provider keys because its OS encryption key is not
part of the profile backup. No server-side token hashes or passwords are changed.

Regression coverage is in `test/tests/apiCredentialsTest.js`, supplemented by
the existing provider-key, account, sync-isolation and shared-repository suites.
The fault-injection tests use synthetic keys and the real Mozilla login database.
To additionally exercise the actual OS keychain on an unlocked development host:

```sh
EPILIB_TEST_NATIVE_KEYCHAIN=1 CI=1 test/runtests.sh apiCredentials
```

Headless CI skips only this native OS-service check; deterministic encryption,
migration, rollback, isolation and race tests still run.

## Shared metadata repository (local desktop engine)

The account server now also exposes `/metadata-repository/v1/health`, `/query`,
and `/records`. These authenticated routes exchange bounded public bibliographic
records, not PDFs or extraction. They do not require a recognition container.
The desktop's local EpiLib engine checks this repository before catalogs; misses
and unavailable/older servers fall back to the normal catalog pipeline. Shared
results always require human review because contributions are unverified.

General > PDF Recognition has separate lookup and contribution checkboxes.
Lookup is enabled by default for local EpiLib; contribution is opt-in. The existing
Account server URL/token is used, with HTTPS required except for loopback HTTP.
Notes, tags, abstracts, arbitrary Extra fields, filenames, URLs, library IDs,
PDF content and credentials are never contributed. Public records are shared
across authenticated users of this server, not restricted by library membership.

The implementation remains in `epilib-pdf-recognition-engine/src/repository-*.mjs`.
Generate the deployment artifact there with:

```sh
npm run build:repository -- ../zotero-desktop/tools/postgresql-sync-server/vendor/recognition-repository
```

Deploy this server including `vendor/recognition-repository`, then restart it
using its existing database/auth configuration. Startup adds independent
`recognition_repository_records` and `recognition_repository_contributions`
tables; existing sync records and account credentials are not changed. A 30-day
TTL, per-account quotas, immutable deduplicated records and process-local request
limits bound storage/traffic. No automatic server restart is performed by a
desktop build. Full protocol/operations documentation is in the engine repository's
`docs/shared-repository.md`.

`node --test test/metadata-repository.test.mjs` checks bundle integrity. Set
`TEST_DATABASE_URL` to enable real two-account API/database integration in a
temporary database. It never changes the supplied database's tables.
