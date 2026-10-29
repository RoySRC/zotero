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

New users can also be created from Zotero's PostgreSQL account pane. The first
user on an empty PostgreSQL server can be created without a token. After that,
`POST /auth/register` requires an existing PostgreSQL account token, so log in
first before creating additional local users.

Passwords can be reset from Zotero's PostgreSQL account pane by entering the
username, current password, and new password. The server verifies the current
password with `POST /auth/password`, updates the stored password hash, revokes
existing tokens for that user, and returns a fresh token.

The custom client then populates the WebDAV profile and library file-storage UI
from those settings. WebDAV passwords are not included in the settings bundle;
they remain local login-manager secrets.

## WebDAV group access propagation

When a group library member list is updated, the server copies the library's
assigned WebDAV profile and library-file-storage assignment into each selected
member's `user_sync_settings` row. If configured, it also updates a WebDAV group
password map such as `auth/group.passwd`.

For a locally accessible file:

```sh
export WEBDAV_GROUP_PASSWD_PATH='/home/src13/zotero-webdav/auth/group.passwd'
```

For a file on another host over SSH:

```sh
export WEBDAV_GROUP_PASSWD_SSH_HOST='src13@cs-arch-27.cmpt.sfu.ca'
export WEBDAV_GROUP_PASSWD_PATH='/localhome/src13/zotero-webdav/auth/group.passwd'
```

By default, the server uses the WebDAV profile ID as the group name in
`group.passwd` and the PostgreSQL username as the WebDAV username. Override
those when they differ:

```sh
export WEBDAV_PROFILE_ACCESS_GROUPS='{"project1":"project-1"}'
export WEBDAV_USERNAME_MAP='{"14718097":"sajeeb","Superjet7914":"sajeeb"}'
```

The profile/group map accepts either profile IDs or normalized WebDAV profile
URLs as keys. The username map accepts either PostgreSQL usernames or Zotero user
IDs as keys.

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
