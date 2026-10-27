# EpiLib installer ownership checks. These are not runtime profile migrations.

; Refuse operations on an unmarked installation, including helper.exe copied
; into another product's directory. Preserve registers used by NSIS callbacks.
!macro EpiLibRequireOwnedInstall
  Push $0
  ReadINIStr $0 "$INSTDIR\${InstallMarker}" "Product" "InstallerIdentity"
  ${If} $0 != "epilib-desktop"
    Pop $0
    MessageBox MB_OK|MB_ICONSTOP "This directory is not an EpiLib installation. No files were changed." /SD IDOK
    Abort
  ${EndIf}
  Pop $0
!macroend

; A fresh install may use only a missing/empty directory. An upgrade must carry
; our marker. Never infer ownership from zotero.exe, a shared Mozilla app ID, or
; the name of the folder. Also reject a library database inside the program dir.
!macro EpiLibCheckInstallDirectory
  ${If} ${FileExists} "$INSTDIR\zotero.sqlite"
  ${OrIf} ${FileExists} "$INSTDIR\prefs.js"
  ${OrIf} ${FileExists} "$INSTDIR\profiles.ini"
    MessageBox MB_OK|MB_ICONSTOP "Choose a separate EpiLib program directory, not a profile or library data directory." /SD IDOK
    Abort
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\${InstallMarker}"
    !insertmacro EpiLibRequireOwnedInstall
  ${Else}
    Push $0
    Push $1
    Push $2
    StrCpy $2 "empty"
    FindFirst $0 $1 "$INSTDIR\*.*"
    ${DoWhile} $1 != ""
      ${If} $1 != "."
      ${AndIf} $1 != ".."
        StrCpy $2 "occupied"
        ${ExitDo}
      ${EndIf}
      FindNext $0 $1
    ${Loop}
    FindClose $0
    ${If} $2 == "occupied"
      Pop $2
      Pop $1
      Pop $0
      MessageBox MB_OK|MB_ICONSTOP "Choose an empty directory or an existing EpiLib installation. Other applications will not be replaced." /SD IDOK
      Abort
    ${EndIf}
    Pop $2
    Pop $1
    Pop $0
  ${EndIf}
!macroend

; Call only after the installation's own files fail a lock check. A window-class
; search or process-name kill could instead target a running official client.
!macro EpiLibFilesInUse MESSAGE
  MessageBox MB_OK|MB_ICONSTOP "${MESSAGE}" /SD IDOK
  Abort
!macroend
