preferences-window =
    .title = { -app-name } Settings

preferences-appearance-title = Appearance and Language

preferences-auto-recognize-files =
    .label = Automatically retrieve metadata for PDFs and ebooks

preferences-file-renaming-title = File Renaming
preferences-file-renaming-intro =
    { -app-name } can automatically rename files based on the details of the parent item (title, author, etc.) and keep the filenames in sync as you make changes. Downloaded files are always initially named based on the parent item.
preferences-file-renaming-configure-button =
    .label = Configure File Renaming…

preferences-attachment-titles-title = Attachment Titles
preferences-attachment-titles-intro = Attachment titles are <label data-l10n-name="wiki-link">different from filenames</label>. To support some workflows, { -app-name } can show filenames instead of attachment titles in the items list.
preferences-attachment-titles-show-filenames =
    .label = Show attachment filenames in the items list

preferences-reader-title = Reader
preferences-reader-open-epubs-using = Open EPUBs using
preferences-reader-open-snapshots-using = Open snapshots using
preferences-reader-open-in-new-window =
    .label = Open files in new windows instead of tabs
preferences-reader-auto-disable-tool =
    .label = Turn off note, text, and image annotation tools after each use
preferences-reader-ebook-font = Ebook font:
preferences-reader-ebook-hyphenate =
    .label = Enable automatic hyphenation

preferences-read-aloud-title = Read Aloud
preferences-read-aloud-highlight-granularity = Highlight current
preferences-read-aloud-highlight-granularity-paragraph =
    .label = paragraph
preferences-read-aloud-highlight-granularity-sentence =
    .label = sentence
preferences-read-aloud-highlight-granularity-word =
    .label = word

preferences-note-title = Notes
preferences-note-open-in-new-window =
    .label = Open notes in new windows instead of tabs

preferences-color-scheme = Color Scheme:
preferences-color-scheme-auto =
    .label = Automatic
preferences-color-scheme-light =
    .label = Light
preferences-color-scheme-dark =
    .label = Dark

preferences-item-pane-header = Item Pane Header:
preferences-item-pane-header-style = Header Citation Style:
preferences-item-pane-header-locale = Header Language:
preferences-item-pane-header-missing-style = Missing style: <{ $shortName }>

preferences-locate-library-lookup-intro = Library Lookup can find a resource online using your library’s OpenURL resolver.
preferences-locate-resolver = Resolver:
preferences-locate-base-url = Base URL:

preferences-quickCopy-minus =
    .aria-label = { general-remove }
    .label = { $label }
preferences-quickCopy-plus =
    .aria-label = { general-add }
    .label = { $label }

preferences-styleManager-intro = { -app-name } can generate citations and bibliographies in over 10,000 citation styles. Add styles here to make them available when selecting styles throughout { -app-name }.
preferences-styleManager-get-additional-styles =
    .label = Get Additional Styles…
preferences-styleManager-restore-default =
    .label = Restore Default Styles…
preferences-styleManager-add-from-file =
    .tooltiptext = Add a style from a file
    .label = Add from File…
preferences-styleManager-remove = Press { delete-or-backspace } to remove this style.
preferences-citation-dialog = Citation Dialog
preferences-citation-dialog-mode = Citation Dialog Mode:
preferences-citation-dialog-mode-last-used =
    .label = Last Used
preferences-citation-dialog-mode-list =
    .label = List Mode
preferences-citation-dialog-mode-library =
    .label = Library Mode

preferences-advanced-enable-local-api =
    .label = Allow other applications on this computer to communicate with { -app-name }
preferences-advanced-local-api-available = Available at <code data-l10n-name="url">{ $url }</span>
preferences-advanced-local-api-clear-authorizations =
    .label = Clear Write Authorizations
preferences-advanced-server-disabled = The { -app-name } HTTP server is disabled.
preferences-advanced-server-enable-and-restart =
    .label = Enable and Restart
preferences-advanced-language-and-region-title = Language and Region
preferences-advanced-enable-bidi-ui =
    .label = Enable bidirectional text editing utilities
preferences-advanced-data-dir =
    .value = Data Directory:
preferences-advanced-reset-data-dir =
    .label = Revert to Default Location…
preferences-advanced-custom-data-dir =
    .label = Use Custom Location…
preferences-advanced-default-data-dir =
    .value = (Default: { $directory })
    .aria-label = Default location

preferences-pane-account = Account

-preferences-sync-data-syncing = Data Syncing
preferences-sync-data-syncing-groupbox =
    .aria-label = { -preferences-sync-data-syncing }
preferences-sync-data-syncing-heading = { -preferences-sync-data-syncing }
preferences-sync-data-syncing-description = Log in with your { -app-name } account to sync your data between devices, collaborate with others, and more.
preferences-sync-settings-heading = Sync
preferences-sync-settings-intro = { -app-name } can sync your library data and files across devices. <label data-l10n-name="sync-link">Learn more</label>
preferences-sync-reset-heading = Sync Reset
preferences-sync-metadata-heading = Metadata Sync
preferences-sync-metadata-description = Choose where library metadata, collections, tags, and attachment records are synced. Attachment files can still use Zotero Storage or WebDAV profiles.
preferences-sync-metadata-backend =
    .value = Metadata backend:
preferences-sync-metadata-backend-zotero =
    .label = zotero.org
preferences-sync-metadata-backend-postgresql =
    .label = PostgreSQL Server
preferences-sync-metadata-save =
    .label = Save
preferences-sync-metadata-zotero-saved = Metadata sync will use zotero.org.
preferences-sync-metadata-postgresql-active = Metadata sync is using a PostgreSQL server. Configure the server below.
preferences-sync-metadata-postgresql-url =
    .value = Server URL:
preferences-sync-metadata-postgresql-url-placeholder =
    .placeholder = http://localhost:23129/
preferences-sync-metadata-postgresql-username =
    .value = Username:
preferences-sync-metadata-postgresql-username-placeholder =
    .placeholder = PostgreSQL sync username
preferences-sync-metadata-postgresql-password =
    .value = Password:
preferences-sync-metadata-postgresql-password-placeholder =
    .placeholder = PostgreSQL sync password
preferences-sync-metadata-postgresql-login =
    .label = Log In and Load Settings
preferences-sync-metadata-postgresql-loading-title = Loading PostgreSQL Account Settings
preferences-sync-metadata-postgresql-saved = PostgreSQL metadata server settings saved.
preferences-sync-metadata-postgresql-syncing = PostgreSQL metadata server linked; syncing library metadata…
preferences-sync-metadata-postgresql-login-succeeded = PostgreSQL metadata server linked for “{ $username }”; sync settings loaded.
preferences-sync-metadata-postgresql-enter-url = Enter the PostgreSQL metadata server URL.
preferences-sync-metadata-postgresql-enter-username = Enter the PostgreSQL metadata username.
preferences-sync-metadata-postgresql-enter-password = Enter the PostgreSQL metadata password.
preferences-sync-metadata-postgresql-login-required = Log in to the PostgreSQL metadata server to save these settings.
preferences-sync-fileSyncing-groups =
    .label = Sync attachment files in group libraries using { -app-name } Storage
preferences-sync-fileSyncing-tos = By using { -app-name } Storage, you agree to become bound by its <label data-l10n-name="terms-link">terms and conditions</label>.
preferences-sync-fileSyncing-webDAVProfiles-title = WebDAV Profiles
preferences-sync-fileSyncing-webDAVProfiles-description = Create named WebDAV file-storage profiles and assign them to libraries. Files are stored in library-specific WebDAV folders. Passwords are stored separately for each profile.
preferences-sync-fileSyncing-profile =
    .value = Profile:
preferences-sync-fileSyncing-profile-new =
    .label = New
preferences-sync-fileSyncing-profile-delete =
    .label = Delete
preferences-sync-fileSyncing-profile-id =
    .value = Profile ID:
preferences-sync-fileSyncing-profile-password-placeholder =
    .placeholder = Leave blank to keep saved password
preferences-sync-fileSyncing-profile-copy-current =
    .label = Use Current WebDAV Settings
preferences-sync-fileSyncing-profile-save =
    .label = Save Profile
preferences-sync-fileSyncing-profile-verify =
    .label = Verify Profile
preferences-sync-fileSyncing-profile-current-loaded = Current WebDAV settings loaded. Save the profile to keep them.
preferences-sync-fileSyncing-profile-enter-id = Enter a profile ID.
preferences-sync-fileSyncing-profile-saved = Profile “{ $profileID }” saved.
preferences-sync-fileSyncing-profile-verified = Profile “{ $profileID }” verified.
preferences-sync-fileSyncing-profile-delete-confirm = Delete WebDAV profile “{ $profileID }” and remove it from any assigned library?
preferences-sync-fileSyncing-profile-deleted = Profile “{ $profileID }” deleted.
preferences-sync-fileSyncing-profile-in-use = { $label } (in use)
preferences-sync-fileSyncing-library-storage-title = Library File Storage
preferences-sync-fileSyncing-library-storage-description = Choose the file-storage backend for each library. “Default” uses { -app-name }’s existing settings above. WebDAV profiles store each library in its own remote folder.
preferences-sync-fileSyncing-default = Default
preferences-sync-fileSyncing-default-no-file-sync = Default (No file sync)
preferences-sync-fileSyncing-default-global-webdav = Default (Global WebDAV)
preferences-sync-fileSyncing-default-zotero-storage = Default ({ -app-name } Storage)
preferences-sync-fileSyncing-webDAVProjects-title = WebDAV Project Libraries
preferences-sync-fileSyncing-webDAVProjects-description = Create local project libraries whose files sync through WebDAV. Metadata sync uses the configured metadata backend.
preferences-sync-fileSyncing-webDAVProject-name =
    .value = Project name:
preferences-sync-fileSyncing-webDAVProject-create =
    .label = Create Project Library
preferences-sync-fileSyncing-webDAVProject-label = WebDAV project
preferences-sync-fileSyncing-webDAVProject-enter-name = Enter a project library name.
preferences-sync-fileSyncing-webDAVProject-select-profile = Select a WebDAV profile.
preferences-sync-fileSyncing-webDAVProject-created = Project library “{ $name }” created.
preferences-sync-fileSyncing-webDAVProject-remove = Remove
preferences-sync-fileSyncing-webDAVProject-remove-confirm = Remove WebDAV project library “{ $name }” from this computer? Remote WebDAV files will not be deleted.
preferences-sync-fileSyncing-webDAVProject-removed = Project library “{ $name }” removed.
preferences-sync-fileSyncing-webDAVProject-missing-profile = Missing WebDAV profile
preferences-account-log-out =
    .label = Log Out…

preferences-sync-reset-restore-to-server-body = { -app-name } will replace “{ $libraryName }” on { $domain } with data from this computer.
preferences-sync-reset-restore-to-server-deleted-items-text = { $remoteItemsDeletedCount } { $remoteItemsDeletedCount ->
        [one] item
        *[other] items
    } in the online library will be permanently deleted.
preferences-sync-reset-restore-to-server-remaining-items-text = { general-sentence-separator }{ $localItemsCount ->
        [0] The library on this computer and the online library will be empty.
        [one] 1 item will remain on this computer and in the online library.
        *[other] { $localItemsCount } items will remain on this computer and in the online library.
    }
preferences-sync-reset-restore-to-server-checkbox-label = { $remoteItemsDeletedCount ->
        [one] Delete 1 item
        *[other] Delete { $remoteItemsDeletedCount } items
    }
preferences-sync-reset-restore-to-server-confirmation-text = delete online library
preferences-sync-reset-restore-to-server-yes = Replace Data in Online Library

preferences-account-log-in =
    .label = Log In
preferences-account-waiting-for-login =
    .value = Waiting for login…
preferences-account-cancel-button =
    .label = { general-cancel }

preferences-account-logged-out-status =
    .value = (logged out)

preferences-account-email-label =
    .value = Email:

preferences-account-switch-accounts =
    .label = Switch Accounts…
preferences-account-switch-text =
    Switching to a different account will remove all { -app-name } data on this computer. Before continuing, make sure all data and files you wish to keep have been synced with the “{ $username }” account or you have a backup of your { -app-name } data directory.
preferences-account-switch-confirmation-text = remove local data
preferences-account-switch-accept = Remove Data and Restart

fulltext-index-status-indexing = Indexing { $indexed } of { $total }…
fulltext-index-status-complete = Search index is up to date
fulltext-stats-attachments-indexed = Attachments indexed:
fulltext-stats-partially-indexed = Partially indexed:
fulltext-stats-not-available = Full-text content or file not available:
fulltext-stats-notes-indexed = Notes indexed:
