EpiLib
======
[![CI](https://github.com/zotero/zotero/actions/workflows/ci.yml/badge.svg)](https://github.com/zotero/zotero/actions/workflows/ci.yml)

EpiLib is an independent research-library application based on [Zotero](https://www.zotero.org/). It is maintained by EpiLib contributors and is not an official Zotero product. Upstream copyright, license and attribution notices are retained.

Custom Implementation
---------------------

This fork keeps Zotero's standard desktop workflow while adding opt-in sync and storage features for custom deployments:

- **PostgreSQL metadata sync backend**: The Sync preferences pane now includes a Metadata Sync section where users can choose between the default zotero.org backend and a self-hosted PostgreSQL server. When PostgreSQL is enabled, EpiLib routes metadata sync requests through the configured server and stores the returned API token in the login manager.
- **Local PostgreSQL sync server tooling**: `tools/postgresql-sync-server/` provides an experimental Zotero-style sync API backed by PostgreSQL, including import from zotero.org, database-backed users, PBKDF2 password hashes, token authentication, group-library management, and persisted sync settings. See `tools/postgresql-sync-server/README.md` for setup and operation.
- **Per-library WebDAV storage profiles**: The Sync preferences pane can create, verify, and save named WebDAV profiles, then assign them to individual user or group libraries. Attachment files are stored under library-specific WebDAV paths, and WebDAV passwords remain separate login-manager secrets.
- **Custom library workflows**: The custom UI supports local WebDAV project libraries and, when using the PostgreSQL metadata backend, creating, updating, and safely deleting group libraries while propagating WebDAV profile assignments to selected members.

PostgreSQL replaces metadata sync only. When PostgreSQL metadata sync is paired with WebDAV file storage, attachment files are stored in WebDAV using the global WebDAV settings or the assigned per-library WebDAV profile. Zotero Storage is used only when it remains the selected file-storage backend.

Report EpiLib-specific issues to this fork's maintainers. The upstream [Zotero Forums](https://forums.zotero.org/) and [Getting Help](https://www.zotero.org/support/getting_help) pages describe official Zotero, not support for this fork.

See [Branding and compatibility](tools/branding/README.md) for the names and identifiers intentionally retained.

For more information on how to use this source code, see the [Zotero documentation](https://www.zotero.org/support/dev/source_code).
