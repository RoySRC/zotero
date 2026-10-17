# EpiLib PDF Recognition Service

## Architecture and boundaries

The desktop still uses Zotero's PDF worker to extract text/layout from opening
pages. In **Settings > General > PDF Recognition**, choosing **EpiLib** sends this
JSON to the existing account server at `/recognizer/recognize`. That server checks
the user's normal database-backed session token, then forwards to this separate
worker using a different, server-to-server secret. The worker never receives the
user's token, account identity, WebDAV credentials, or library database access.

The worker resolves identifiers and bibliographic hints into complete item JSON.
The desktop validates this record and creates the parent item without a second
translator lookup. Collection membership, attachment placement, renaming, and
undo continue through the existing recognition workflow. EPUB behavior is unchanged.

Selecting **Zotero** explicitly keeps the original service and client translators.
An unavailable EpiLib worker never silently falls back to Zotero. The public
[Zotero client](https://github.com/zotero/zotero/blob/main/chrome/content/zotero/xpcom/recognizeDocument.js)
uses a hybrid model: results may contain identifiers for client-side translators
or bibliographic fields for direct item creation. This does not establish how
Zotero's private recognition server is implemented internally.

## Start the separate container

Requirements: Docker Compose and Node 24 for local tests/evaluation. No GROBID,
PostgreSQL database, or full Crossref download is required for online mode.

From this directory, create a secret in an operator-owned location. Use a fresh
secret, not the user's account API key, and do not commit it:

```sh
mkdir -p secrets
chmod 700 secrets
openssl rand -hex 32 > secrets/recognition.key
chmod 600 secrets/recognition.key
export RECOGNITION_SERVICE_KEY_FILE="$PWD/secrets/recognition.key"
export RECOGNITION_UID="$(id -u)" RECOGNITION_GID="$(id -g)"
export PROVIDER_CONTACT='operator@example.org'
docker compose up -d --build
```

Run Compose as a non-root operator. The container uses that operator's numeric
UID/GID (default 1000:1000), so it can read the mode-600 mounted secret without
making it world-readable. It runs without capabilities, with a
read-only filesystem, 512 MB memory ceiling, one CPU, and a PID limit. Its port
23130 is published on loopback only. Those are worker limits, NOT recommended
GROBID limits. Verify your platform's secret-file ownership if startup fails.

Configure the **account/sync server** separately and restart it with its existing
database configuration unchanged:

```sh
export RECOGNITION_SERVICE_URL='http://127.0.0.1:23130/'
export RECOGNITION_SERVICE_KEY_FILE='/absolute/path/to/secrets/recognition.key'
```

If both services run in containers, use a private Docker network and the worker's
service DNS name/port (`http://recognition:8080/`), not loopback. Mount the same
secret into each container. Do not expose the worker publicly. Use TLS on any
cross-host connection. Deploy the updated desktop, gateway, and worker together;
an old desktop does not understand version 2 records. The new desktop can still
read the old version 1 service during a staggered upgrade.

The deployment fails explicitly with HTTP 503 if the worker is not configured;
it does not execute recognition inside the metadata-sync process. **Verify Engine**
checks the full authenticated gateway-to-worker path without sending a document.

## Request and response contract

Worker requests use `Authorization: Bearer <service secret>`; the external account
server retains its existing `Zotero-API-Key` session header. JSON payloads are
limited to 5 MB. At most four recognition jobs run concurrently; excess jobs get
503. Provider calls have an 8-second timeout, 2 MB response cap, per-host pacing,
and Retry-After cooldowns. The gateway caps replies at 1 MB and waits at most 25
seconds. Redirects are rejected at both boundaries. Errors never echo document
text, provider responses, passwords, or tokens.

`GET /health` returns:

```json
{"engine":"epilib","version":2,"protocol":"epilib-recognition-v2","reports":false}
```

`POST /recognize` accepts the unchanged PDF-worker shape:

```json
{"totalPages":20,"pages":[],"metadata":{"DOI":"10.1234/example"},"fileName":"document.pdf"}
```

In real extraction, `pages` contains up to five positional layout arrays. Word
text is at index 13 of each 14-element word tuple; word spacing is index 5. The
extractor bounds recursion/characters and reads identifiers only from explicit
metadata or labelled opening material, not a document-wide bibliography search.

The response is one of:

```json
{"engine":"epilib","version":2,"status":"matched","item":{"itemType":"journalArticle","title":"Example","creators":[],"DOI":"10.1234/example","libraryCatalog":"Crossref"},"evidence":{"method":"identifier","identifier":{"doi":"10.1234/example"},"provider":"Crossref"}}
```

- `matched`: `item` is a normalized bibliographic record, with `evidence`.
- `needs_review`: `candidates` contains at most five `{item, evidence, score?}`
  entries. The desktop asks before accepting any candidate. Cancel creates nothing.
- `no_match`: no supported, sufficiently plausible match; no parent is created.

Supported item types are articles, books, chapters, conference papers, theses,
reports, and preprints. Unsupported provider types abstain. Returned fields are
an intentional subset, not a full copy of every provider field. The desktop
whitelists bibliographic fields, strips remote record keys/IDs, and places a DOI
in `extra` if that item type has no native DOI field.

The bibliographic projection includes abstracts (up to 20,000 characters), language,
rights, repository/archive identifiers, and automatic subject tags when supplied
by the provider. Subjects are deduplicated, capped at 100 tags of 255 characters,
and respect the desktop's automatic-tag preference. Remote item IDs, attachment
URLs as child objects, notes, collection membership, and sync state are excluded.
Missing provider fields remain missing; recognition does not invent a journal or
issue for an unpublished preprint.

DataCite uses `descriptions` with `descriptionType: Abstract`, `rightsList`,
`subjects`, and explicit `identifiers`. Its `Issued` date takes precedence;
preprints may fall back to `Submitted`, then `Available`, then `publicationYear`.
An `Updated` date is not the original publication date. These meanings follow the
[DataCite description schema](https://datacite-metadata-schema.readthedocs.io/en/4.6/properties/description/)
and [date schema](https://datacite-metadata-schema.readthedocs.io/en/4.6/properties/date/).
Crossref abstracts and language, and arXiv Atom summaries, are preserved too.

Online cache keys use the `bibliography-v3:` prefix to bypass older projections
that omitted these fields. Offline Crossref indexes contain normalized records,
not raw provider JSON: re-import an existing sample to populate the new fields.
Updating the recognizer does not rewrite existing library items automatically.

## Matching policy and provider integration

1. Resolve explicit DOI via Crossref, with DataCite fallback on Crossref 404.
2. Resolve arXiv identifiers via the arXiv Atom API, verifying the returned ID.
3. Resolve checksum-valid ISBNs via Open Library edition metadata.
4. Without a resolved identifier, search Crossref using bounded title/author/year
   hints. If it has no unique exact-title, author-corroborated result without a
   year conflict, also search arXiv by title. Whole pages, filenames, affiliations,
   email addresses, and user tokens are never intentionally sent to providers.
5. After identifying a preprint, check for a verified published version as described
   below. An identifier or a cached repository record does not skip this step.
6. An exact normalized title plus author corroboration, no year contradiction,
   and sufficient separation from the next result may auto-match. Layout-derived
   titles always require review. Explicit title contradictions also require review.

Scores are heuristic ranking evidence, **not calibrated confidence probabilities**.
Evaluate precision on a labelled corpus before relaxing any threshold. This
implementation does not claim parity with Zotero recognition or cover all books,
scanned documents, languages, DOI agencies, or publication types. A provider outage
can be recovered by a plausible result from the other provider; an outage with
no plausible candidate remains an error, not a no-match result, and does not
trigger heavier GROBID fallback work.

### Header extraction and title-search fallback

When an explicit PDF title or author is absent, `getHints()` examines only the
first page's opening header (at most 35 lines, stopping before the abstract,
introduction, or references). It excludes conference/review banners, identifier
lines, URLs, copyright notices, and email addresses from title selection. Font
size, boldness, and reading order rank title candidates; adjacent lines with
similar typography can form one wrapped title. Nearby personal-name-shaped
bylines supply author hints, while common affiliations are excluded. These are
heuristics, not a trained document model or a complete multilingual name parser.
They intentionally keep `source: "layout"`, requiring confirmation even when
the eventual provider record matches the title, authors, and year exactly.

For example, a PDF beginning with `Published as a conference paper at ICLR 2023`
must use the paper title below that banner, not search for the banner itself.
`test/header-search.test.mjs` covers this case, wrapped titles, author columns,
body/reference exclusion, and positive/negative lookup outcomes without private
PDF fixtures or live network calls.

arXiv title searches use a punctuation-normalized quoted `ti:` phrase and fetch
at most five results, following the [arXiv API query syntax](https://info.arxiv.org/help/api/user-manual.html#details-of-query-construction).
No author/year filter is imposed on the search itself because a preprint can
have a different publication date or name spelling; corroboration and conflicts
are evaluated afterward. The adapter validates each arXiv ID and maps title,
authors, abstract, publication date, repository and URL using the same projection
as identifier lookup. Existing arXiv pacing, timeouts and response-size limits
also apply to title search.

### Published-version resolution

Identification and publication status are separate decisions. An arXiv ID locates
the work; it does not mean the preferred catalog record must be a preprint.
`fromArxiv()` retains bounded DOI, journal-reference and comment hints. The worker
checks a supplied publication DOI with Crossref, otherwise searches Crossref and
the public OpenReview v1/v2 title indexes. OpenReview supports both plain and
`{value: ...}` content fields. Only accepted conference venues are mapped;
submitted, rejected, withdrawn and DBLP mirror records are excluded. BibTeX type
alone is not evidence of acceptance. OpenReview submission/public-posting dates
are not used as publication dates; the venue year is kept at year precision.

An upgrade requires an exact normalized title and the complete matching author
list. Initials and middle-name differences are tolerated, but two different full
given names, missing authors or title revisions cannot silently merge works.
One corroborated publication supersedes its repository version. Multiple plausible
publications require review. A publication banner with no verified published
record also requires review, rather than relabeling a preprint from PDF text.
The published date/venue come from the publication provider, not the repository.
`alternateIdentifiers.arxiv` retains the repository ID; the desktop validates it
and stores `arXiv: ...` in Extra. It never accepts arbitrary provider Extra text.

Enrichment adds at most six seconds of provider time (two seconds per request),
inside a 22-second overall provider budget. Outages retain the identified record
and carry `publicationLookup: incomplete` evidence. No negative result is cached.
Positive relationships use a separate `publication-v1:` cache with one-day expiry;
cache hits do not extend their lifetime. Old source caches are bypassed by the
new bibliography prefix. Offline mode never calls publication providers.

For **Label-Free Concept Bottleneck Models**, the accepted record is **ICLR 2023**,
not ICML or a journal article. The public fixture links arXiv `2304.06129` to
OpenReview forum `FlCg47MNvBA`. No paper title/ID is hard-coded in the resolver.

For an existing preprint, enable EpiLib recognition and right-click the parent
item, then choose **Update to Published Version...**. Review the candidate's type,
venue, authors and date before accepting. This action sends only existing metadata,
not a PDF, and updates the same item key. Attachments, annotations, collections,
tags and user Extra are preserved. A preprint DOI is moved to Extra when it differs
from the publication DOI. Concurrent edits, cancellation, no match or missing write
permission leave the item unchanged. Existing items are never bulk-rewritten.

`test/publication-version.test.mjs` covers the reported regression, cold/warm caches,
provider failures, title-only recognition, both OpenReview formats, false acceptance,
different authors and ambiguous versions. Desktop tests cover the menu, confirmation,
field validation and preservation of the existing item graph.

After deploying this worker, retry **Retrieve Metadata** on an existing standalone
PDF. A layout-based match opens the existing candidate confirmation dialog. No
new desktop protocol or preferences are required, and existing library records
are not silently overwritten.

Each adapter exposes `resolve(kind, identifier)` and/or `search(hints)`, returns
normalized item JSON, and must verify identifiers before accepting a response.
Add mocked tests for not-found, mismatched identifiers, rate limits, and malformed
responses before adding a provider. Never accept a provider URL from PDF text.

## Optional local GROBID

The desktop checkbox **Use local GROBID when EpiLib finds no match** defaults off.
Enabling it reveals a labelled loopback URL and **Verify Local GROBID** button.
This feature does not download, install, start, or benchmark GROBID for the user.
Use a separately installed version after assessing its RAM, CPU, model, and disk
requirements on the intended machine. The default URL is `http://127.0.0.1:8070/`.

Only numeric loopback hosts (`127.0.0.1` or `[::1]`) are accepted. After a genuine
no-match, the desktop sends the local PDF (maximum 50 MB) directly to
`api/processHeaderDocument`, not through the sync server. The multipart filename
is `document.pdf`, no account credentials/cookies are included, redirects are
rejected, and the timeout is 60 seconds. Queue cancellation aborts the local XHR.
There is one active desktop recognition job, no extra extraction queue.

`consolidateHeader=0` disables GROBID's external metadata consolidation, and
`start=0`, `end=2` bound header processing. TEI is size-limited and DTD/entity
declarations are rejected. Only title/author/year/DOI hints go back to the worker
for another lookup. Failed or ambiguous normal lookups do not invoke GROBID.
This is header extraction, not OCR; image-only PDFs still need a separate OCR
solution. Refer to the official [service API](https://grobid.readthedocs.io/en/latest/Grobid-service/).

## Evaluate a local Crossref index

The worker supports `LOOKUP_MODE=online` (default), `hybrid` (local first), and
`local` (no provider network calls, including on a miss). Set a **dedicated**
`RECOGNITION_DATABASE_URL` for Compose, or `DATABASE_URL` for CLI/Node execution.
Do not reuse the library-sync database or credentials. Tables are created by
`createStore()` in `src/store.mjs`:

- `metadata_cache`: public identifier-to-record cache with one-day expiry.
- `crossref_records`: public DOI primary key, normalized JSONB, title, generated
  full-text search vector, and GIN index. Upserts preserve one row per DOI.

Without PostgreSQL, online mode uses a 1,000-record memory cache. Local-only mode
requires an imported database to find anything. There is no index auto-download.

Start with a trusted JSON/JSON.gz snapshot shard or a saved REST response:

```sh
npm ci
npm run evaluate:crossref -- --file /path/to/shard.json.gz --limit 1000
# For a saved REST response, use --path message.items instead of items.
DATABASE_URL='postgres://...' npm run evaluate:crossref -- \
  --file /path/to/shard.json.gz --limit 10000 --import
```

Input is streamed and limited to 1..100,000 records per run (default 1,000).
The report measures supported/skipped records, read/normalized bytes, elapsed
time, peak process RSS, actual database/index bytes, and p50/p95 latency for paired
DOI/title lookups on up to 100 imported records. No private PDFs are involved.
Use a disposable database first; `--import` writes only when explicitly selected.

A small sample is not a full-corpus sizing or quality benchmark. Measure several
representative shards, update/re-import throughput, storage amplification, query
quality with realistic title noise, and concurrent p95 latency. The initial
PostgreSQL title index requires all query tokens; fuzzy matching, multilingual
retrieval, comprehensive type coverage, incremental refresh scheduling, and
corpus lifecycle management are follow-on work, not solved by a bulk download.

Crossref describes a public annual snapshot and more frequent subscriber
snapshots in its [retrieval guidance](https://www.crossref.org/documentation/retrieve-metadata/rest-api/tips-for-using-the-crossref-rest-api/).
Assess current access terms, attribution, corpus size, and refresh needs before
committing to a complete mirror. Nothing in this implementation downloads one.

### Initial bounded measurement

A local macOS/Node 24 run against PostgreSQL 16 in Docker used 100 public Crossref
REST results for `query=metadata retrieval` (not private PDFs). The importer
accepted 95 supported publication records and skipped five unsupported types.
It measured approximately 92 ms import time, 92 MiB peak **CLI process** RSS,
168 KiB of table/index storage, and 0.85/2.01 ms p50/p95 for the paired DOI/title
lookups. These warm-cache, single-client numbers exclude PostgreSQL's memory,
network download time, and the full corpus. They validate the evaluation path,
not production capacity or recognition accuracy. The disposable database was
removed after testing; no mirror is running or scheduled.

## Source map and testing

| File | Responsibility |
| --- | --- |
| `src/extraction.mjs` | Bounded layout parsing, validated identifiers, bibliographic hints |
| `src/providers.mjs` | Fixed provider hosts, pacing, response limits, adapters |
| `src/metadata.mjs` | Typed bibliographic mapping and conservative ranking |
| `src/engine.mjs` | Lookup order, cache/index selection, result envelope |
| `src/store.mjs` | Public-record cache and optional PostgreSQL index |
| `src/app.mjs` | Worker authentication, body limits, active-job bound |
| `src/server.mjs` | Configuration, process startup, graceful shutdown |
| `src/evaluate-crossref.mjs` | Bounded sample import and resource/latency measurements |
| `../postgresql-sync-server/src/recognizer-routes.mjs` | User-authenticated gateway and credential replacement |

Run `npm test` here and in `../postgresql-sync-server`. With an isolated PostgreSQL
instance, set `TEST_DATABASE_URL` to exercise persistence; tests create/drop their
own randomly named database. Desktop tests are in
`test/tests/recognitionEngineTest.js`: routing, local-only extraction, complete
records, ambiguous cancellation, UI binding, and backward compatibility. Existing
sync regression suites remain independent. CI runs both service suites and the
native desktop tests. No test contacts the user's configured sync/WebDAV services.
