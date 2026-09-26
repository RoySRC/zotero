BEGIN;

CREATE TABLE IF NOT EXISTS account_identity (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    user_id BIGINT NOT NULL,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    emails JSONB NOT NULL DEFAULT '[]'::jsonb,
    password_hash TEXT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE account_identity
    ADD COLUMN IF NOT EXISTS password_hash TEXT NULL;

CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    zotero_user_id BIGINT NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    emails JSONB NOT NULL DEFAULT '[]'::jsonb,
    password_hash TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_tokens (
    token_id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ NULL,
    expires_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS auth_tokens_user
    ON auth_tokens (user_id);

INSERT INTO users (zotero_user_id, username, display_name, emails, password_hash, updated_at)
SELECT user_id, username, display_name, emails, password_hash, updated_at
FROM account_identity
WHERE id = 1
ON CONFLICT (zotero_user_id) DO UPDATE
SET username = EXCLUDED.username,
    display_name = EXCLUDED.display_name,
    emails = EXCLUDED.emails,
    password_hash = COALESCE(users.password_hash, EXCLUDED.password_hash),
    updated_at = now();

CREATE TABLE IF NOT EXISTS sync_settings (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_sync_settings (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO user_sync_settings (user_id, data, updated_at)
SELECT users.id, sync_settings.data, sync_settings.updated_at
FROM sync_settings
JOIN account_identity ON account_identity.id = 1
JOIN users ON users.zotero_user_id = account_identity.user_id
WHERE sync_settings.id = 1
ON CONFLICT (user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS libraries (
    id BIGSERIAL PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('user', 'group')),
    type_id BIGINT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    version BIGINT NOT NULL DEFAULT 0,
    storage_usage BIGINT NOT NULL DEFAULT 0,
    group_version BIGINT NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (type, type_id)
);

ALTER TABLE libraries
    ADD COLUMN IF NOT EXISTS storage_usage BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS objects (
    object_id BIGSERIAL,
    library_id BIGINT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    object_type TEXT NOT NULL CHECK (object_type IN ('item', 'collection', 'search')),
    key TEXT NOT NULL,
    version BIGINT NOT NULL,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (library_id, object_type, key)
);

CREATE SEQUENCE IF NOT EXISTS objects_object_id_seq;

ALTER TABLE objects
    ADD COLUMN IF NOT EXISTS object_id BIGINT;

UPDATE objects
    SET object_id = nextval('objects_object_id_seq')
    WHERE object_id IS NULL;

ALTER TABLE objects
    ALTER COLUMN object_id SET DEFAULT nextval('objects_object_id_seq'),
    ALTER COLUMN object_id SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'objects_object_id_unique'
            AND conrelid = 'objects'::regclass
    ) THEN
        ALTER TABLE objects
            ADD CONSTRAINT objects_object_id_unique UNIQUE (object_id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS objects_library_type_version
    ON objects (library_id, object_type, version);

CREATE TABLE IF NOT EXISTS settings (
    library_id BIGINT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    version BIGINT NOT NULL,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (library_id, key)
);

CREATE TABLE IF NOT EXISTS deleted_objects (
    library_id BIGINT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    object_type TEXT NOT NULL,
    key TEXT NOT NULL,
    version BIGINT NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (library_id, object_type, key)
);

CREATE INDEX IF NOT EXISTS deleted_objects_library_type_version
    ON deleted_objects (library_id, object_type, version);

CREATE TABLE IF NOT EXISTS fulltext_items (
    library_id BIGINT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    version BIGINT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    indexed_pages BIGINT NULL,
    total_pages BIGINT NULL,
    indexed_chars BIGINT NULL,
    total_chars BIGINT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (library_id, key)
);

CREATE INDEX IF NOT EXISTS fulltext_items_library_version
    ON fulltext_items (library_id, version);

CREATE TABLE IF NOT EXISTS storage_accounts (
    user_id BIGINT PRIMARY KEY,
    quota_mb BIGINT NOT NULL DEFAULT 0,
    expiration TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage_files (
    storage_file_id BIGSERIAL PRIMARY KEY,
    hash TEXT NOT NULL,
    filename TEXT NOT NULL,
    size BIGINT NOT NULL DEFAULT 0,
    zip BOOLEAN NOT NULL DEFAULT false,
    last_added TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (hash, filename, zip)
);

CREATE INDEX IF NOT EXISTS storage_files_hash_zip
    ON storage_files (hash, zip);

CREATE TABLE IF NOT EXISTS storage_file_libraries (
    storage_file_id BIGINT NOT NULL REFERENCES storage_files(storage_file_id) ON DELETE CASCADE,
    library_id BIGINT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    PRIMARY KEY (storage_file_id, library_id)
);

CREATE INDEX IF NOT EXISTS storage_file_libraries_library
    ON storage_file_libraries (library_id);

CREATE TABLE IF NOT EXISTS storage_files_existing (
    storage_file_id BIGINT PRIMARY KEY REFERENCES storage_files(storage_file_id) ON DELETE CASCADE,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage_last_sync (
    user_id BIGINT PRIMARY KEY,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage_upload_queue (
    upload_key TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    hash TEXT NOT NULL,
    filename TEXT NOT NULL,
    zip BOOLEAN NOT NULL DEFAULT false,
    item_hash TEXT NOT NULL,
    item_filename TEXT NOT NULL,
    size BIGINT NOT NULL,
    mtime BIGINT NOT NULL,
    content_type TEXT NULL,
    charset TEXT NULL,
    queued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS storage_upload_queue_user
    ON storage_upload_queue (user_id);

CREATE INDEX IF NOT EXISTS storage_upload_queue_queued_at
    ON storage_upload_queue (queued_at);

CREATE TABLE IF NOT EXISTS storage_file_items (
    storage_file_id BIGINT NOT NULL REFERENCES storage_files(storage_file_id) ON DELETE CASCADE,
    object_id BIGINT NOT NULL REFERENCES objects(object_id) ON DELETE CASCADE,
    mtime BIGINT NOT NULL,
    size BIGINT NOT NULL DEFAULT 0,
    item_hash TEXT NULL,
    item_filename TEXT NULL,
    content_type TEXT NULL,
    charset TEXT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (storage_file_id, object_id),
    UNIQUE (object_id)
);

CREATE INDEX IF NOT EXISTS storage_file_items_file
    ON storage_file_items (storage_file_id);

CREATE OR REPLACE FUNCTION update_library_storage_usage_after_storage_file_item_insert()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE libraries
        SET storage_usage = storage_usage + COALESCE(NEW.size, 0),
            updated_at = now()
        FROM objects
        WHERE objects.object_id = NEW.object_id
            AND libraries.id = objects.library_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_library_storage_usage_after_storage_file_item_update()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE libraries
        SET storage_usage = storage_usage + COALESCE(NEW.size, 0) - COALESCE(OLD.size, 0),
            updated_at = now()
        FROM objects
        WHERE objects.object_id = NEW.object_id
            AND libraries.id = objects.library_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_library_storage_usage_after_storage_file_item_delete()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE libraries
        SET storage_usage = GREATEST(0, storage_usage - COALESCE(OLD.size, 0)),
            updated_at = now()
        FROM objects
        WHERE objects.object_id = OLD.object_id
            AND libraries.id = objects.library_id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS storage_file_items_storage_usage_insert ON storage_file_items;
CREATE TRIGGER storage_file_items_storage_usage_insert
    AFTER INSERT ON storage_file_items
    FOR EACH ROW
    EXECUTE FUNCTION update_library_storage_usage_after_storage_file_item_insert();

DROP TRIGGER IF EXISTS storage_file_items_storage_usage_update ON storage_file_items;
CREATE TRIGGER storage_file_items_storage_usage_update
    AFTER UPDATE OF size, object_id ON storage_file_items
    FOR EACH ROW
    EXECUTE FUNCTION update_library_storage_usage_after_storage_file_item_update();

DROP TRIGGER IF EXISTS storage_file_items_storage_usage_delete ON storage_file_items;
CREATE TRIGGER storage_file_items_storage_usage_delete
    AFTER DELETE ON storage_file_items
    FOR EACH ROW
    EXECUTE FUNCTION update_library_storage_usage_after_storage_file_item_delete();

WITH stored_attachments AS (
    SELECT
        o.object_id,
        o.library_id,
        lower(trim(o.data->>'md5')) AS item_hash,
        lower(trim(COALESCE(NULLIF(o.data->>'zipMD5', ''), o.data->>'md5'))) AS storage_hash,
        COALESCE(NULLIF(o.data->>'zipFilename', ''), NULLIF(o.data->>'filename', ''), (o.data->>'key') || '.zip') AS storage_filename,
        (
            o.data ? 'zipMD5'
            OR o.data ? 'zipFilename'
            OR lower(COALESCE(o.data->>'zip', 'false')) IN ('true', 't', '1', 'yes')
        ) AS zip,
        CASE
            WHEN COALESCE(o.data->>'filesize', o.data->>'size') ~ '^[0-9]+$'
                THEN COALESCE(o.data->>'filesize', o.data->>'size')::BIGINT
            ELSE 0
        END AS size,
        (o.data->>'mtime')::BIGINT AS mtime,
        COALESCE(NULLIF(o.data->>'filename', ''), NULLIF(o.data->>'title', ''), o.data->>'key') AS item_filename,
        NULLIF(o.data->>'contentType', '') AS content_type,
        NULLIF(o.data->>'charset', '') AS charset
    FROM objects o
    WHERE o.object_type = 'item'
        AND o.data->>'itemType' = 'attachment'
        AND lower(COALESCE(o.data->>'linkMode', '')) IN ('imported_file', 'imported_url')
        AND COALESCE(o.data->>'md5', '') <> ''
        AND COALESCE(o.data->>'mtime', '') ~ '^[0-9]+$'
),
upserted_storage_files AS (
    INSERT INTO storage_files (hash, filename, size, zip, last_added)
    SELECT DISTINCT storage_hash, storage_filename, size, zip, now()
    FROM stored_attachments
    WHERE storage_hash <> ''
        AND storage_filename <> ''
    ON CONFLICT (hash, filename, zip) DO UPDATE
    SET size = GREATEST(storage_files.size, EXCLUDED.size),
        last_added = now()
    RETURNING storage_file_id, hash, filename, zip
)
INSERT INTO storage_file_libraries (storage_file_id, library_id)
SELECT DISTINCT sf.storage_file_id, sa.library_id
FROM stored_attachments sa
JOIN storage_files sf
    ON sf.hash = sa.storage_hash
    AND sf.filename = sa.storage_filename
    AND sf.zip = sa.zip
ON CONFLICT DO NOTHING;

WITH stored_attachments AS (
    SELECT
        o.object_id,
        o.library_id,
        lower(trim(o.data->>'md5')) AS item_hash,
        lower(trim(COALESCE(NULLIF(o.data->>'zipMD5', ''), o.data->>'md5'))) AS storage_hash,
        COALESCE(NULLIF(o.data->>'zipFilename', ''), NULLIF(o.data->>'filename', ''), (o.data->>'key') || '.zip') AS storage_filename,
        (
            o.data ? 'zipMD5'
            OR o.data ? 'zipFilename'
            OR lower(COALESCE(o.data->>'zip', 'false')) IN ('true', 't', '1', 'yes')
        ) AS zip,
        CASE
            WHEN COALESCE(o.data->>'filesize', o.data->>'size') ~ '^[0-9]+$'
                THEN COALESCE(o.data->>'filesize', o.data->>'size')::BIGINT
            ELSE 0
        END AS size,
        (o.data->>'mtime')::BIGINT AS mtime,
        COALESCE(NULLIF(o.data->>'filename', ''), NULLIF(o.data->>'title', ''), o.data->>'key') AS item_filename,
        NULLIF(o.data->>'contentType', '') AS content_type,
        NULLIF(o.data->>'charset', '') AS charset
    FROM objects o
    WHERE o.object_type = 'item'
        AND o.data->>'itemType' = 'attachment'
        AND lower(COALESCE(o.data->>'linkMode', '')) IN ('imported_file', 'imported_url')
        AND COALESCE(o.data->>'md5', '') <> ''
        AND COALESCE(o.data->>'mtime', '') ~ '^[0-9]+$'
)
INSERT INTO storage_file_items
    (storage_file_id, object_id, mtime, size, item_hash, item_filename, content_type, charset, updated_at)
SELECT
    sf.storage_file_id,
    sa.object_id,
    sa.mtime,
    sa.size,
    sa.item_hash,
    sa.item_filename,
    sa.content_type,
    sa.charset,
    now()
FROM stored_attachments sa
JOIN storage_files sf
    ON sf.hash = sa.storage_hash
    AND sf.filename = sa.storage_filename
    AND sf.zip = sa.zip
ON CONFLICT (object_id) DO UPDATE
SET storage_file_id = EXCLUDED.storage_file_id,
    mtime = EXCLUDED.mtime,
    size = EXCLUDED.size,
    item_hash = EXCLUDED.item_hash,
    item_filename = EXCLUDED.item_filename,
    content_type = EXCLUDED.content_type,
    charset = EXCLUDED.charset,
    updated_at = now();

WITH stored_attachments AS (
    SELECT
        o.library_id,
        lower(trim(COALESCE(NULLIF(o.data->>'zipMD5', ''), o.data->>'md5'))) AS storage_hash,
        COALESCE(NULLIF(o.data->>'zipFilename', ''), NULLIF(o.data->>'filename', ''), (o.data->>'key') || '.zip') AS storage_filename,
        (
            o.data ? 'zipMD5'
            OR o.data ? 'zipFilename'
            OR lower(COALESCE(o.data->>'zip', 'false')) IN ('true', 't', '1', 'yes')
        ) AS zip
    FROM objects o
    WHERE o.object_type = 'item'
        AND o.data->>'itemType' = 'attachment'
        AND lower(COALESCE(o.data->>'linkMode', '')) IN ('imported_file', 'imported_url')
        AND COALESCE(o.data->>'md5', '') <> ''
        AND COALESCE(o.data->>'mtime', '') ~ '^[0-9]+$'
)
INSERT INTO storage_file_libraries (storage_file_id, library_id)
SELECT DISTINCT sf.storage_file_id, sa.library_id
FROM stored_attachments sa
JOIN storage_files sf
    ON sf.hash = sa.storage_hash
    AND sf.filename = sa.storage_filename
    AND sf.zip = sa.zip
ON CONFLICT DO NOTHING;

UPDATE libraries l
SET storage_usage = COALESCE(summary.total_size, 0)
FROM (
    SELECT o.library_id, SUM(sfi.size) AS total_size
    FROM storage_file_items sfi
    JOIN objects o ON o.object_id = sfi.object_id
    GROUP BY o.library_id
) summary
WHERE summary.library_id = l.id;

UPDATE libraries l
SET storage_usage = 0
WHERE NOT EXISTS (
    SELECT 1
    FROM storage_file_items sfi
    JOIN objects o ON o.object_id = sfi.object_id
    WHERE o.library_id = l.id
);

COMMIT;
