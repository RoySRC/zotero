# PDF Recognition Gateway

Recognition version 2 runs in a separate container. This server only authenticates
the user and forwards bounded requests with a private service credential. It does
not perform provider lookups, run GROBID, or store PDF extraction data.

See [the recognition service guide](../recognition-server/README.md) for the full
architecture, beginner-oriented source map, API contracts, provider integration,
local GROBID settings, Crossref sample evaluation, deployment, and tests.

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
