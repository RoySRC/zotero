# Recognition engine moved

The backend is now the independent **epilib-pdf-recognition-engine** repository.
In this workspace it is a sibling of `zotero-desktop`:

```text
Zotero/
  epilib-pdf-recognition-engine/
  zotero-desktop/
```

See [the engine README](../../../epilib-pdf-recognition-engine/README.md) for setup,
tests, provider configuration, Docker deployment, and corpus audit tooling. This
directory is only a migration pointer, not a second implementation or a symlink.

PDF extraction, recognition settings/review UI, and native integration tests stay
in the desktop app. The PostgreSQL server keeps its authenticated HTTP gateway;
see [RECOGNITION.md](../postgresql-sync-server/RECOGNITION.md). No worker source
checkout is required to build the desktop or run the gateway.

For an existing local deployment, run Compose from the new engine repository,
preserving its service-key file, environment, and project name:

```sh
docker compose -p epilib-recognition up -d --build recognition
```

The worker remains at `http://127.0.0.1:23130/` with the same
`epilib-recognition-v2` protocol. Desktop and account settings do not change.
