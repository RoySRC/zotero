# PDF Recognition: Architecture and Extension Guide

## What this feature does

PDF recognition asks **which publication a PDF represents**. It is independent
of metadata synchronization, WebDAV attachment storage, and open-access PDF
discovery. Recognition does not move files or change sync backends.

Settings > General > PDF Recognition has a native **Engine** dropdown:

| Engine | Destination | Authentication |
| --- | --- | --- |
| Zotero | Existing recognizer service, or the existing `recognize.url` override | No EpiLib account token |
| EpiLib | The Account Settings PostgreSQL HTTP server, with `recognizer/` appended | Existing per-user PostgreSQL session token |

The saved preference is `extensions.zotero.recognize.engine`, with values
`zotero` and `epilib`. The default remains `zotero` for compatibility. Selecting
EpiLib is explicit and does **not** silently switch back if its server fails.
The internal `extensions.zotero` namespace remains for profile compatibility;
it does not mean a request is being sent to Zotero.

EpiLib v1 is a conservative, identifier-first engine. It recognizes explicit
DOI, arXiv, or checksum-valid ISBN identifiers. It is **not** a replacement for
all of Zotero's recognition capabilities: it has no OCR, model inference,
title-similarity search, or reference-disambiguation service. Ambiguity and
unsupported documents return no match, not invented metadata.

## Request lifecycle

1. `getRecognitionConfiguration()` snapshots the engine and server URL when
   recognition of a PDF starts. Changing Settings cannot reroute that PDF midway.
2. The existing PDF worker, `getRecognizerData()`, extracts metadata and layout
   information for up to five pages locally. The PDF binary is not uploaded.
3. `queryPDFMetadata()` sends this same JSON to the selected recognizer. For
   EpiLib, it retrieves the current account token from the login manager and
   checks that the configured server did not change while awaiting it.
4. The server's existing authentication middleware resolves that token to a
   PostgreSQL user. `createRecognizerRouter()` refuses unauthenticated requests,
   applies a 5 MB JSON limit, and calls the pure `recognizeExtraction()` function.
5. The engine extracts a single candidate identifier or returns JSON `null`.
6. The desktop reuses its existing DOI/arXiv/ISBN translators to resolve a match
   into bibliographic metadata. Those translators may contact Crossref, arXiv,
   library catalogs, or other configured lookup providers. Selecting EpiLib does
   **not** make those subsequent lookups offline or first-party-only.
7. Existing desktop logic creates the parent item, moves the PDF beneath it,
   preserves collection membership, and applies existing attachment-renaming
   rules. Existing undo behavior remains in place. EPUB recognition is unchanged.

## Code map

| File | Responsibility |
| --- | --- |
| `src/recognizer.mjs` | Pure extraction-to-identifier engine; no SQL, network, or filesystem access |
| `src/recognizer-routes.mjs` | Authentication guard, HTTP contract, input size, safe error responses |
| `src/server.mjs` | Mounts recognition after existing PostgreSQL token authentication |
| `../../chrome/content/zotero/xpcom/recognizeDocument.js` | Engine snapshot, authenticated transport, response validation, existing translation flow |
| `../../chrome/content/zotero/preferences/preferences_general.{js,xhtml}` | Dropdown, endpoint display, document-free verification |
| `../../chrome/locale/en-US/zotero/preferences.ftl` | Localizable labels and error/status messages |
| `../../test/tests/recognitionEngineTest.js` | Desktop routing, privacy boundaries, result creation, native preferences tests |
| `test/recognizer.test.mjs` | Algorithm fixtures and isolated HTTP router tests |
| `test/object-updates.test.mjs` | Integration coverage with real SQL-backed token authentication |

## HTTP contract

All routes use the existing `Zotero-API-Key` compatibility header, containing an
**EpiLib PostgreSQL account token**, not a zotero.org API key. No database schema
change or extra credential is required.

### GET `/recognizer/health`

Does not extract or send document data. The Settings **Verify Engine** button
calls this endpoint and requires this protocol/version:

```json
{
  "engine": "epilib",
  "version": 1,
  "protocol": "zotero-recognizer-json",
  "reports": false
}
```

### POST `/recognizer/recognize`

The body is the existing PDF-worker JSON, plus `fileName` from the desktop:

```json
{
  "metadata": { "DOI": "10.1234/example" },
  "totalPages": 12,
  "pages": [],
  "fileName": "example.pdf"
}
```

This abbreviated example uses a metadata identifier. Real extraction includes
up to five pages. Each page has this positional structure:

```javascript
[
  pageWidth,
  pageHeight,
  [[[[0, 0, 0, 0, lines]]]]
]
// Each line: [words]
// Each word:
[
  xMin, yMin, xMax, yMax, fontSize, spaceAfter,
  baseline, rotation, underlined, bold, italic,
  colorIndex, fontIndex, text
]
```

`pageLines()` recognizes word arrays by shape and text at index 13. It respects
`spaceAfter`; flattening every value into strings would incorrectly treat layout
coordinates and font numbers as publication identifiers. It bounds nesting,
visited nodes, and text length as defense in depth after the HTTP body limit.

Successful responses use HTTP 200 and exactly one of these shapes:

```json
{ "doi": "10.1234/example" }
```

```json
{ "arxiv": "2401.12345" }
```

```json
{ "isbn": "9783034602891" }
```

```json
null
```

`null` is a legitimate no-match response. HTTP 400 means malformed or
over-budget extraction; 403 means authentication failed; 413 means the body is
larger than 5 MB; 500 means an unexpected server error. A non-JSON error page or
an incompatible response is not treated as bibliographic data.

The desktop retains the upstream richer response format for Zotero and future
EpiLib strategies: identifiers and/or `title`, `authors` (first/last names), and
optional bibliographic fields such as `year`, `abstract`, and `container`.

### POST `/recognizer/report`

Returns HTTP 501. EpiLib v1 has no feedback retention policy or review pipeline,
so it does not pretend to accept reports or save extracted PDF text. The desktop
rejects EpiLib feedback before extracting/sending a document. For Zotero results,
explicit feedback uses the original engine URL recorded in memory, even if the
user has since selected a different engine. Results without that in-session
provenance cannot be reported, preventing accidental uploads to another provider.

## Matching rules and limitations

`recognizeExtraction()` first examines explicit metadata keys: DOI, ISBN, and
arXiv, including `prism:`/`dc:` variants. It does not search filenames, Title,
or Subject for identifiers. A single metadata candidate takes precedence over
page text. Multiple distinct candidates cause abstention.

If explicit metadata has no match, the engine reads the opening text:

- Labelled DOI/arXiv values must occur on page one before Abstract/Introduction.
- ISBN labels can occur on either of the first two pages, including copyright pages.
- References/Bibliography headings terminate scanning for that page.
- ISBN check digits are validated; arXiv revision suffixes are removed.
- DOI trailing punctuation is removed while balanced parentheses are preserved.
- Duplicate identical values collapse to one candidate; different identifiers,
  including competing identifier families, return no match.

These are conservative heuristics, **not a guarantee of identity**. A cited DOI
in a cover sheet can still be misleading; an unlabeled DOI or a title without an
identifier can be missed. Review matches and retain undo support. Do not broaden
matching to "the first DOI anywhere in a document": references commonly contain
identifiers belonging to other publications.

## Privacy and transport

- The EpiLib engine itself makes no outbound requests and persists no payloads.
- It shares normal server account authentication; there is no anonymous route.
- Routes send `Cache-Control: no-store`; errors do not echo document text.
- Client requests disable cookies, redirects, and body logging. There is no
  cross-engine retry. HTTP transport still logs ordinary request URLs/statuses.
- No token is stored in the preference or recognition-origin maps.
- Use HTTPS outside trusted local development. HTTP is supported for existing
  local deployments but does not protect tokens or PDF text in transit.
- A reverse proxy or external HTTP instrumentation can log bodies independently
  of this code. Disable such logging for recognition routes in deployment.
- Identifier translation is a separate step and may use external services as
  described above. Existing translator debug logs are not removed by this feature.

## Deploying and enabling

1. Deploy the updated `tools/postgresql-sync-server` source to the existing server,
   including both new recognizer modules. There are no new npm dependencies.
2. Restart that HTTP service through its existing process manager. Keep its normal
   database connection and account/token configuration; do not change passwords.
3. Rebuild/restart the desktop. Log in under Account Settings using the existing
   server URL. Do not use the desktop Connector port, 23119, as the server URL.
4. Choose **General > PDF Recognition > Engine > EpiLib**, then **Verify Engine**.
5. Run the existing metadata-recognition command on a standalone PDF.

An older deployed HTTP server returns 404 for these routes. Rebuilding only the
desktop does not update the remote server. The Verify Engine error deliberately
does not fall back to uploading the PDF to Zotero.

## Testing

From this server directory:

```sh
npm test
```

Pure engine and HTTP router tests need no database. To include real authentication
and the existing sync integration suite, point `TEST_DATABASE_URL` to a dedicated
development PostgreSQL instance whose role can create test databases:

```sh
TEST_DATABASE_URL='postgres://test-user:test-password@localhost:5432/postgres' npm test
```

The harness creates/drops a randomly named database; it does not modify the
database named by the URL. Do not supply production credentials.

From the desktop repository root:

```sh
npm run build
CI=1 bash test/runtests.sh -f -b recognitionEngine epilibSyncIsolation epilibBranding
CI=1 bash test/runtests.sh -f -b -g 'standalone PDF by ISBN' recognizeDocument
```

The focused upstream ISBN test exercises the real PDF extractor with mocked HTTP
and lookup results. The full upstream recognition suite also contains tests of
live external services, including ebook lookups; those are not CI gates here.
The existing rebranding workflows include these desktop tests and server tests.
The external Zotero provider label is allowlisted so an upstream branding pass
does not rename both dropdown choices to EpiLib.

## Extending the engine safely

Start by adding a representative fixture and its expected result to
`test/recognizer.test.mjs`. Include a competing reference/citation as a negative
case. Add a small, documented matching strategy in `recognizer.mjs`; keep its
inputs/outputs separate from Express, SQL, and desktop UI.

For title search, model inference, or a service such as GROBID, explicitly define
confidence thresholds, timeout/resource budgets, outbound destinations, and
retention policy before connecting it. An optional strategy must not silently
forward extracted text to Zotero or another external provider. Preserve JSON
`null` as an ordinary no-match outcome. Extend the versioned protocol and tests
if the response contract changes, instead of relying on unvalidated object keys.

Keep extension points documented with purpose, parameters, output, failure cases,
and privacy implications. Block comments should explain reasoning and data-shape
assumptions; the guide carries the larger architectural explanation.
