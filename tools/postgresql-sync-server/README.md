# Zotero PostgreSQL Sync Server

Experimental metadata-sync server for the custom Zotero build. WebDAV remains
the file/blob backend; this service replaces WebDAV metadata sync with a
PostgreSQL-backed Zotero-style sync API.

## Setup

```sh
createdb zotero_sync
psql "$DATABASE_URL" -f schema.sql
npm install
```

## Import from zotero.org

Create a temporary zotero.org API key with library and group read access, then
run:

```sh
export DATABASE_URL='postgres://user:password@localhost:5432/zotero_sync'
export ZOTERO_IMPORT_API_KEY='temporary-zotero-org-api-key'
npm run import:zotero -- --replace
```

The importer copies account identity, group registry, settings, collections,
searches, items, and attachment item records into PostgreSQL while preserving
Zotero user IDs, group IDs, object keys, object versions, and library versions.
It refuses to import into a non-empty metadata database unless `--replace` is
provided.

## Run

```sh
export DATABASE_URL='postgres://user:password@localhost:5432/zotero_sync'
npm start
```

The server listens on `http://localhost:23129/` by default.

Authentication is database-backed. Imported Zotero identities are stored in
`users`, login passwords are stored as PBKDF2 hashes in PostgreSQL, and successful
logins issue per-user API tokens stored in `auth_tokens`. Runtime
`ZOTERO_SYNC_PASSWORD` is not used.

After importing an account, set or rotate its login password with the one-time
admin CLI:

```sh
npm run user:password -- --username sajeeb
```

The login identity comes from the imported `users` row, so use that row's
`username` in Zotero's Account pane. On successful login the server returns a
fresh per-user API token plus any saved sync settings from `/sync/settings`.
The custom client then populates the WebDAV profile and library file-storage UI
from those settings. WebDAV passwords are not included in the settings bundle;
they remain local login-manager secrets.

## Configure the custom Zotero app

In Zotero's Run JavaScript window:

```js
await Zotero.Sync.Metadata.configurePostgreSQL({
  url: "http://localhost:23129/",
  apiKey: "token-returned-by-auth-login"
});
return Zotero.Sync.Metadata.getPostgreSQLBaseURL();
```

To return to zotero.org metadata sync:

```js
await Zotero.Sync.Metadata.disablePostgreSQL();
return Zotero.Sync.Metadata.getBackend();
```

## Notes

- This is a focused sync backend, not a full zotero.org clone.
- It implements the API surface currently used by `Zotero.Sync.APIClient`.
- PostgreSQL stores object JSON, stable internal object IDs, per-library versions,
  settings, delete logs, and Zotero-style storage-file mapping tables.
- Group discovery is minimal and intended for local/private deployments.

## Zotero Storage API References

The relevant upstream storage/backend repositories are:

- `dataserver`: canonical server implementation. The storage API lives in
  `controllers/StorageController.php`, `model/Storage.inc.php`, and the
  `storageFiles`, `storageFileLibraries`, `storageUploadQueue`,
  `storageFileItems`, and `shardLibraries.storageUsage` schema in `misc/*.sql`.
- `zotero-desktop`: client-side Zotero File Storage/WebDAV behavior in
  `chrome/content/zotero/xpcom/storage/zfs.js`,
  `chrome/content/zotero/xpcom/storage/webdav.js`, and local attachment sync
  state in `storageLocal.js`.
- `zotero-docs`: public Web API file-upload contract in
  `content/dev/web_api/v3/file_upload.md`.
- `zfs-purge`: maintenance/purge logic for file blobs and library references.
- `attachment-proxy`: attachment delivery/proxy support used by the hosted
  backend.

The PostgreSQL schema mirrors the part of the hosted backend that matters for
sync correctness: libraries have a `storage_usage` counter; each sync object has
a stable `object_id`; files are deduplicated in `storage_files`; libraries hold
explicit references in `storage_file_libraries`; attachment items map to files
through `storage_file_items`; pending upload metadata has a place in
`storage_upload_queue`. A pure metadata import can populate attachment hash,
filename, and mtime, but it cannot know actual blob size unless the later file
migration/upload step records it, so imported storage sizes default to `0`.
