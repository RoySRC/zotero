# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Required Plugins:
# AppAssocReg http://nsis.sourceforge.net/Application_Association_Registration_plug-in
# ShellLink   http://nsis.sourceforge.net/ShellLink_plug-in
# UAC         http://nsis.sourceforge.net/UAC_plug-in

; Set verbosity to 2 to lessen the noise in the build logs
!verbose 2

; 7-Zip provides better compression than the lzma from NSIS so we add the files
; uncompressed and use 7-Zip to create a SFX archive of it
SetDatablockOptimize on
SetCompress off
CRCCheck on

RequestExecutionLevel user

!addplugindir ./

; On Vista and above attempt to elevate Standard Users in addition to users that
; are a member of the Administrators group.
!define NONADMIN_ELEVATE

; prevents compiling of the reg write logging.
!define NO_LOG

; Other included files may depend upon these includes!
; The following includes are provided by NSIS.
!include FileFunc.nsh
!include LogicLib.nsh
!include MUI.nsh
!include WinMessages.nsh
!include WinVer.nsh
!include WordFunc.nsh

!insertmacro GetSize
!insertmacro StrFilter
!insertmacro WordReplace

!insertmacro un.GetParent

; The following includes are custom.
!include branding.nsi
!include defines.nsi
!include isolation.nsh
!include common.nsh
!include locales.nsi

; This is named BrandShortName helper because we use this for software update
; post update cleanup.
VIAddVersionKey "FileDescription" "${BrandShortName} Helper"
VIAddVersionKey "OriginalFilename" "helper.exe"

!insertmacro AddHandlerValues
!insertmacro ElevateUAC
!insertmacro GetOptions
!insertmacro GetParameters
!insertmacro GetPathFromString
!insertmacro IsHandlerForInstallDir
!insertmacro LogDesktopShortcut
!insertmacro LogQuickLaunchShortcut
!insertmacro LogStartMenuShortcut
!insertmacro RegCleanMain
!insertmacro RegCleanUninstall
!insertmacro SetAppLSPCategories
!insertmacro SetBrandNameVars
!insertmacro UpdateShortcutAppModelIDs
!insertmacro UpdateUninstallLog
!insertmacro WriteRegDWORD2
!insertmacro WriteRegStr2

!insertmacro un.ChangeMUIHeaderImage
!insertmacro un.CheckForFilesInUse
!insertmacro un.CleanUpdatesDir
!insertmacro un.DeleteShortcuts
!insertmacro un.ElevateUAC
!insertmacro un.GetSecondInstallPath
!insertmacro un.ParseUninstallLog
!insertmacro un.RegCleanAppHandler
!insertmacro un.RegCleanFileHandler
!insertmacro un.RegCleanMain
!insertmacro un.RegCleanProtocolHandler
!insertmacro un.RegCleanUninstall
!insertmacro un.SetAppLSPCategories
!insertmacro un.SetBrandNameVars

!include shared.nsh

; Helper macros for ui callbacks. Insert these after shared.nsh
!insertmacro OnEndCommon

!insertmacro un.OnEndCommon

Name "${BrandFullName}"
OutFile "helper.exe"
!ifdef HAVE_64BIT_BUILD
  InstallDir "$PROGRAMFILES64\${BrandFullName}\"
!else
  InstallDir "$PROGRAMFILES32\${BrandFullName}\"
!endif
ShowUnInstDetails nevershow

################################################################################
# Modern User Interface - MUI

!define MUI_ABORTWARNING
!define MUI_ICON setup.ico
!define MUI_UNICON setup.ico
!define MUI_WELCOMEPAGE_TITLE_3LINES
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
#TODO !define MUI_UNWELCOMEFINISHPAGE_BITMAP wizWatermark.bmp

; Use a right to left header image when the language is right to left
#TODO !ifdef ${AB_CD}_rtl
#TODO !define MUI_HEADERIMAGE_BITMAP_RTL wizHeaderRTL.bmp
#TODO !else
#TODO !define MUI_HEADERIMAGE_BITMAP wizHeader.bmp
#TODO !endif

/**
 * Uninstall Pages
 */
; Welcome Page
!define MUI_PAGE_CUSTOMFUNCTION_PRE un.preWelcome
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.leaveWelcome
!insertmacro MUI_UNPAGE_WELCOME

; Custom Uninstall Confirm Page
UninstPage custom un.preConfirm un.leaveConfirm

; Remove Files Page
!insertmacro MUI_UNPAGE_INSTFILES

; Finish Page

; Don't setup the survey controls, functions, etc. when the application has
; defined NO_UNINSTALL_SURVEY
!ifndef NO_UNINSTALL_SURVEY
!define MUI_PAGE_CUSTOMFUNCTION_PRE un.preFinish
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT $(SURVEY_TEXT)
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION un.Survey
!endif

!insertmacro MUI_UNPAGE_FINISH

; Use the default dialog for IDD_VERIFY for a simple Banner
ChangeUI IDD_VERIFY "${NSISDIR}\Contrib\UIs\default.exe"

################################################################################
# Install Sections
; Empty section required for the installer to compile as an uninstaller
Section ""
SectionEnd

################################################################################
# Uninstall Sections

Section "Uninstall"
  !insertmacro EpiLibRequireOwnedInstall
  SetDetailsPrint textonly
  DetailPrint $(STATUS_UNINSTALL_MAIN)
  SetDetailsPrint none

  ; Retain all profiles, credentials and library data. Runtime profiles may
  ; still be shared with older builds or the official application.

  ; Check whether EpiLib was installed under HKLM. If it was we will need to elevate.
  SetShellVarContext all
  Push "0"
  Push $INSTDIR
  Call un.IterateUninstallKeys
  ; The error flag means no key was found. In that case set to user uninstall.
  ; When a key is found in HKLM leave shell context to all and trigger
  ; elevation prompt.
  IfErrors 0 elevate
  SetShellVarContext current
  Goto elevation_complete
  elevate:
  ${un.ElevateUAC}
  elevation_complete:
  Pop $Trash
  Pop $Trash

  ; Delete the app exe to prevent launching the app while we are uninstalling.
  ClearErrors
  ${DeleteFile} "$INSTDIR\${FileMainEXE}"
  ${If} ${Errors}
    ; If the user closed the application it can take several seconds for it to
    ; shut down completely. If the application is being used by another user we
    ; can still delete the files when the system is restarted.
    Sleep 5000
    ${DeleteFile} "$INSTDIR\${FileMainEXE}"
    ClearErrors
  ${EndIf}

  ; The retained runtime identity can share a taskbar group with older clients.
  ; Do not delete that group's jump lists when removing this installation.

  ClearErrors
  ${un.RegCleanMain} "${InstallerRegistryKey}"
  ${un.RegCleanUninstall}
  ${un.DeleteShortcuts}
  ${un.SetAppLSPCategories}
  
  ${un.RegCleanProtocolHandler} "zotero"
  ${un.RegCleanAppHandler} "EpiLibRIS"
  ${un.RegCleanAppHandler} "EpiLibISI"
  ${un.RegCleanAppHandler} "EpiLibMODS"
  ${un.RegCleanAppHandler} "EpiLibRDF"
  ${un.RegCleanAppHandler} "EpiLibBibTeX"
  ${un.RegCleanAppHandler} "EpiLibMARC"
  ${un.RegCleanAppHandler} "EpiLibCSL"

  ClearErrors
  ReadRegStr $R9 HKCR "EpiLibRDF" ""
  ; Don't clean up the file handlers if the EpiLibRDF key still exists since
  ; there should be a second installation that may be the default file handler
  ${If} ${Errors}
    ${un.RegCleanFileHandler}  ".rdf"    "EpiLibRDF"
    ${un.RegCleanFileHandler}  ".ris"    "EpiLibRIS"
    ${un.RegCleanFileHandler}  ".isi"    "EpiLibISI"
    ${un.RegCleanFileHandler}  ".mods"   "EpiLibMODS"
    ${un.RegCleanFileHandler}  ".bib"    "EpiLibBibTeX"
    ${un.RegCleanFileHandler}  ".bibtex" "EpiLibBibTeX"
    ${un.RegCleanFileHandler}  ".marc"   "EpiLibMARC"
    ${un.RegCleanFileHandler}  ".csl"    "EpiLibCSL"
  ${EndIf}

  ${un.GetSecondInstallPath} "${InstallerRegistryKey}" $R9

  StrCpy $0 "Software\Microsoft\Windows\CurrentVersion\App Paths\${AppPathAlias}"
  ${If} $R9 == "false"
    DeleteRegKey SHCTX "$0"
  ${Else}
    ReadRegStr $R1 SHCTX "$0" ""
    Push $R1
    Call un.RemoveQuotesFromPath
    Pop $R1
    ${un.GetParent} "$R1" $R1
    ${If} "$INSTDIR" == "$R1"
      WriteRegStr SHCTX "$0" "" "$R9"
      ${un.GetParent} "$R9" $R1
      WriteRegStr SHCTX "$0" "Path" "$R1"
    ${EndIf}
  ${EndIf}

  ; Remove directories and files we always control before parsing the uninstall
  ; log so empty directories can be removed.
  ${If} ${FileExists} "$INSTDIR\updates"
    RmDir /r /REBOOTOK "$INSTDIR\updates"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\defaults\shortcuts"
    RmDir /r /REBOOTOK "$INSTDIR\defaults\shortcuts"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\distribution"
    RmDir /r /REBOOTOK "$INSTDIR\distribution"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\removed-files"
    Delete /REBOOTOK "$INSTDIR\removed-files"
  ${EndIf}

  ; Do not remove shared runtime update/profile caches.

  ; Parse the uninstall log to unregister dll's and remove all installed
  ; files / directories this install is responsible for.
  ${un.ParseUninstallLog}

  ; Remove only files recorded by this installer, not arbitrary files by
  ; extension or by a Zotero/EpiLib directory-name prefix.
  
  ; Remove the uninstall directory that we control
  RmDir /r /REBOOTOK "$INSTDIR\uninstall"

  ; Remove the installation directory if it is empty
  ${RemoveDir} "$INSTDIR"

  ; If firefox.exe was successfully deleted yet we still need to restart to
  ; remove other files create a dummy firefox.exe.moz-delete to prevent the
  ; installer from allowing an install without restart when it is required
  ; to complete an uninstall.
  ${If} ${RebootFlag}
    ${Unless} ${FileExists} "$INSTDIR\${FileMainEXE}.moz-delete"
      FileOpen $0 "$INSTDIR\${FileMainEXE}.moz-delete" w
      FileWrite $0 "Will be deleted on restart"
      Delete /REBOOTOK "$INSTDIR\${FileMainEXE}.moz-delete"
      FileClose $0
    ${EndUnless}
  ${EndIf}

  ; Refresh desktop icons otherwise the start menu internet item won't be
  ; removed and other ugly things will happen like recreation of the app's
  ; clients registry key by the OS under some conditions.
  System::Call "shell32::SHChangeNotify(i ${SHCNE_ASSOCCHANGED}, i 0, i 0, i 0)"
SectionEnd

################################################################################
# Helper Functions

; Don't setup the survey controls, functions, etc. when the application has
; defined NO_UNINSTALL_SURVEY
!ifndef NO_UNINSTALL_SURVEY
Function un.Survey
  Exec "$\"$TmpVal$\" $\"${SurveyURL}$\""
FunctionEnd
!endif

################################################################################
# Language

!insertmacro MOZ_MUI_LANGUAGE 'baseLocale'
!verbose push
!verbose 3
!include "overrideLocale.nsh"
!include "customLocale.nsh"
!verbose pop

; Set this after the locale files to override it if it is in the locale. Using
; " " for BrandingText will hide the "Nullsoft Install System..." branding.
BrandingText " "

################################################################################
# Page pre, show, and leave functions

Function un.preWelcome
  ${If} ${FileExists} "$INSTDIR\distribution\modern-wizard.bmp"
    Delete "$PLUGINSDIR\modern-wizard.bmp"
    CopyFiles /SILENT "$INSTDIR\distribution\modern-wizard.bmp" "$PLUGINSDIR\modern-wizard.bmp"
  ${EndIf}
FunctionEnd

Function un.leaveWelcome
  ${If} ${FileExists} "$INSTDIR\${FileMainEXE}"
    Banner::show /NOUNLOAD "$(BANNER_CHECK_EXISTING)"

    ; On a retry, give this installation's locked files five seconds to close.
    ${If} "$TmpVal" == "FoundMessageWindow"
      Sleep 5000
    ${EndIf}

    ${PushFilesToCheck}

    ${un.CheckForFilesInUse} $TmpVal

    Banner::destroy

    ; If there are files in use $TmpVal will be "true"
    ${If} "$TmpVal" == "true"
      ; Keep the existing retry flag, but never search by shared window class.
      StrCpy $TmpVal "FoundMessageWindow"
      !insertmacro EpiLibFilesInUse "$(WARN_MANUALLY_CLOSE_APP_UNINSTALL)"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.preConfirm
  ${If} ${FileExists} "$INSTDIR\distribution\modern-header.bmp"
  ${AndIf} $hHeaderBitmap == ""
    Delete "$PLUGINSDIR\modern-header.bmp"
    CopyFiles /SILENT "$INSTDIR\distribution\modern-header.bmp" "$PLUGINSDIR\modern-header.bmp"
    ${un.ChangeMUIHeaderImage} "$PLUGINSDIR\modern-header.bmp"
  ${EndIf}

  ; Setup the unconfirm.ini file for the Custom Uninstall Confirm Page
  WriteINIStr "$PLUGINSDIR\unconfirm.ini" "Settings" NumFields "3"

  WriteINIStr "$PLUGINSDIR\unconfirm.ini" "Field 1" Type   "label"
  WriteINIStr "$PLUGINSDIR\unconfirm.ini" "Field 1" Text   "$(UN_CONFIRM_UNINSTALLED_FROM)"
  WriteINIStr "$PLUGINSDIR\unconfirm.ini" "Field 1" Left   "0"
  WriteINIStr "$PLUGINSDIR\unconfirm.ini" "Field 1" Right  "-1"
  WriteINIStr "$PLUGINSDIR\unconfirm.ini" "Field 1" Top    "5"
  WriteINIStr "$PLUGINSDIR\unconfirm.ini" "Field 1" Bottom "15"

  WriteINIStr "$PLUGINSDIR\unconfirm.ini" "Field 2" Type   "text"
  ; The contents of this control must be set as follows in the pre function
  ; ${MUI_INSTALLOPTIONS_READ} $1 "unconfirm.ini" "Field 2" "HWND"
  ; SendMessage $1 ${WM_SETTEXT} 0 "STR:$INSTDIR"
  WriteINIStr "$PLUGINSDIR\unconfirm.ini" "Field 2" State  ""
  WriteINIStr "$PLUGINSDIR\unconfirm.ini" "Field 2" Left   "0"
  WriteINIStr "$PLUGINSDIR\unconfirm.ini" "Field 2" Right  "-1"
  WriteINIStr "$PLUGINSDIR\unconfirm.ini" "Field 2" Top    "17"
  WriteINIStr "$PLUGINSDIR\unconfirm.ini" "Field 2" Bottom "30"
  WriteINIStr "$PLUGINSDIR\unconfirm.ini" "Field 2" flags  "READONLY"

  ; No profile-removal checkbox: retained runtime identities can share data.
  WriteINIStr "$PLUGINSDIR\unconfirm.ini" "Field 3" Type "label"
  WriteINIStr "$PLUGINSDIR\unconfirm.ini" "Field 3" Text "Settings, credentials and library data will be retained."
  WriteINIStr "$PLUGINSDIR\unconfirm.ini" "Field 3" Left "0"
  WriteINIStr "$PLUGINSDIR\unconfirm.ini" "Field 3" Right "-1"
  WriteINIStr "$PLUGINSDIR\unconfirm.ini" "Field 3" Top "40"
  WriteINIStr "$PLUGINSDIR\unconfirm.ini" "Field 3" Bottom "70"

  !insertmacro MUI_HEADER_TEXT "$(UN_CONFIRM_PAGE_TITLE)" "$(UN_CONFIRM_PAGE_SUBTITLE)"
  ; The Summary custom page has a textbox that will automatically receive
  ; focus. This sets the focus to the Install button instead.
  !insertmacro MUI_INSTALLOPTIONS_INITDIALOG "unconfirm.ini"
  GetDlgItem $0 $HWNDPARENT 1
  System::Call "user32::SetFocus(i r0, i 0x0007, i,i)i"
  ${MUI_INSTALLOPTIONS_READ} $1 "unconfirm.ini" "Field 2" "HWND"
  SendMessage $1 ${WM_SETTEXT} 0 "STR:$INSTDIR"
  !insertmacro MUI_INSTALLOPTIONS_SHOW
FunctionEnd

Function un.leaveConfirm
  ; Recheck only this installation's executable before proceeding. Do not
  ; search for or close another client with the same process/window name.
  ClearErrors
  ${DeleteFile} "$INSTDIR\${FileMainEXE}"
  ${If} ${Errors}
    !insertmacro EpiLibFilesInUse "$(WARN_MANUALLY_CLOSE_APP_UNINSTALL)"
  ${EndIf}
FunctionEnd

!ifndef NO_UNINSTALL_SURVEY
Function un.preFinish
  ; Do not modify the finish page if there is a reboot pending
  ${Unless} ${RebootFlag}
    ; Setup the survey controls, functions, etc.
    StrCpy $TmpVal "SOFTWARE\Microsoft\IE Setup\Setup"
    ClearErrors
    ReadRegStr $0 HKLM $TmpVal "Path"
    ${If} ${Errors}
      !insertmacro MUI_INSTALLOPTIONS_WRITE "ioSpecial.ini" "settings" "NumFields" "3"
    ${Else}
      ExpandEnvStrings $0 "$0" ; this value will usually contain %programfiles%
      ${If} $0 != "\"
        StrCpy $0 "$0\"
      ${EndIf}
      StrCpy $0 "$0\iexplore.exe"
      ClearErrors
      GetFullPathName $TmpVal $0
      ${If} ${Errors}
        !insertmacro MUI_INSTALLOPTIONS_WRITE "ioSpecial.ini" "settings" "NumFields" "3"
      ${Else}
        ; When we add an optional action to the finish page the cancel button
        ; is enabled. This disables it and leaves the finish button as the
        ; only choice.
        !insertmacro MUI_INSTALLOPTIONS_WRITE "ioSpecial.ini" "settings" "cancelenabled" "0"
      ${EndIf}
    ${EndIf}
  ${EndUnless}
FunctionEnd
!endif

################################################################################
# Initialization Functions

Function .onInit
  ; Prevents breaking apps that don't use SetBrandNameVars
  !ifdef SetBrandNameVars
    ${SetBrandNameVars} "$EXEDIR\distribution\setup.ini"
  !endif

  ; Prevent launching the application when a reboot is required and this
  ; executable is the main application executable
  IfFileExists "$EXEDIR\${FileMainEXE}.moz-upgrade" +1 +4
  MessageBox MB_YESNO|MB_ICONEXCLAMATION "$(WARN_RESTART_REQUIRED_UPGRADE)" IDNO +2
  Reboot
  Quit ; Nothing initialized so no need to call OnEndCommon

  ${GetParent} "$EXEDIR" $INSTDIR
  Push $INSTDIR
  Call GetLongPath
  Pop $INSTDIR
  !insertmacro EpiLibRequireOwnedInstall
  IfFileExists "$INSTDIR\${FileMainEXE}" +2 +1
  Quit ; Nothing initialized so no need to call OnEndCommon

  ; Prevents breaking apps that don't use SetBrandNameVars
  !ifdef SetBrandNameVars
    ${SetBrandNameVars} "$INSTDIR\distribution\setup.ini"
  !endif

  ; Application update uses a directory named tobedeleted in the $INSTDIR to
  ; delete files on OS reboot when they are in use. Try to delete this
  ; directory if it exists.
  ${If} ${FileExists} "$INSTDIR\tobedeleted"
    RmDir /r "$INSTDIR\tobedeleted"
  ${EndIf}

  ; Prevent all operations (e.g. set as default, postupdate, etc.) when a
  ; reboot is required and the executable launched is helper.exe
  IfFileExists "$INSTDIR\${FileMainEXE}.moz-upgrade" +1 +4
  MessageBox MB_YESNO|MB_ICONEXCLAMATION "$(WARN_RESTART_REQUIRED_UPGRADE)" IDNO +2
  Reboot
  Quit ; Nothing initialized so no need to call OnEndCommon

  !ifdef HAVE_64BIT_BUILD
    SetRegView 64
  !endif

  ${GetParameters} $R0

  StrCmp "$R0" "" continue +1

  ; Update this user's shortcuts with the latest app user model id.
  ClearErrors
  ${GetOptions} "$R0" "/UpdateShortcutAppUserModelIds" $R2
  IfErrors postupdate +1
  ${UpdateShortcutAppModelIDs}  "$INSTDIR\${FileMainEXE}" "${AppUserModelID}" $R2
  StrCmp "$R2" "true" finish +1 ; true indicates that shortcuts have been updated
  Quit ; Nothing initialized so no need to call OnEndCommon

  ; Do not attempt to elevate. The application launching this executable is
  ; responsible for elevation if it is required.
  postupdate:
  ${WordReplace} "$R0" "$\"" "" "+" $R0
  ClearErrors
  ${GetOptions} "$R0" "/PostUpdate" $R2
  IfErrors continue +1
  ; If the uninstall.log does not exist don't perform post update
  ; operations. This prevents updating the registry for zip builds.
  IfFileExists "$EXEDIR\uninstall.log" +2 +1
  Quit ; Nothing initialized so no need to call OnEndCommon
  ${PostUpdate}
  ClearErrors
  ${GetOptions} "$R0" "/UninstallLog=" $R2
  IfErrors updateuninstalllog +1
  StrCmp "$R2" "" finish +1
  GetFullPathName $R3 "$R2"
  IfFileExists "$R3" +1 finish
  Delete "$INSTDIR\uninstall\*wizard*"
  Delete "$INSTDIR\uninstall\uninstall.log"
  CopyFiles /SILENT /FILESONLY "$R3" "$INSTDIR\uninstall\"
  ${GetParent} "$R3" $R4
  Delete "$R3"
  RmDir "$R4"
  GoTo finish

  ; Do not attempt to elevate. The application launching this executable is
  ; responsible for elevation if it is required.
  updateuninstalllog:
  ${UpdateUninstallLog}

  finish:
  ${UnloadUAC}
  System::Call "shell32::SHChangeNotify(i ${SHCNE_ASSOCCHANGED}, i 0, i 0, i 0)"
  Quit ; Nothing initialized so no need to call OnEndCommon

  continue:

  ; If the uninstall.log does not exist don't perform uninstall
  ; operations. This prevents running the uninstaller for zip builds.
  IfFileExists "$INSTDIR\uninstall\uninstall.log" +2 +1
  Quit ; Nothing initialized so no need to call OnEndCommon

  ; If we made it this far then this installer is being used as an uninstaller.
  WriteUninstaller "$EXEDIR\uninstaller.exe"

  ${Unless} ${Silent}
    ; Manually check for /S in the command line due to Bug 506867
    ClearErrors
    ${GetOptions} "$R0" "/S" $R2
    ${Unless} ${Errors}
      SetSilent silent
    ${Else}
      ; Support for the deprecated -ms command line argument.
      ClearErrors
      ${GetOptions} "$R0" "-ms" $R2
      ${Unless} ${Errors}
        SetSilent silent
      ${EndUnless}
    ${EndUnless}
  ${EndUnless}

  ${If} ${Silent}
    StrCpy $R1 "$\"$EXEDIR\uninstaller.exe$\" /S"
  ${Else}
    StrCpy $R1 "$\"$EXEDIR\uninstaller.exe$\""
  ${EndIf}

  ; When the uninstaller is launched it copies itself to the temp directory
  ; so it won't be in use so it can delete itself.
  ExecWait $R1
  ${DeleteFile} "$EXEDIR\uninstaller.exe"
  SetErrorLevel 0
  Quit ; Nothing initialized so no need to call OnEndCommon
FunctionEnd

Function un.onInit
  StrCpy $LANGUAGE 0

  ${un.GetParent} "$INSTDIR" $INSTDIR
  Push $INSTDIR
  Call un.GetLongPath
  Pop $INSTDIR
  !insertmacro EpiLibRequireOwnedInstall
  ${Unless} ${FileExists} "$INSTDIR\${FileMainEXE}"
  Abort
  ${EndUnless}

  !ifdef HAVE_64BIT_BUILD
  SetRegView 64
  !endif

  ; Prevents breaking apps that don't use SetBrandNameVars
  !ifdef un.SetBrandNameVars
  ${un.SetBrandNameVars} "$INSTDIR\distribution\setup.ini"
  !endif

  ; Initialize $hHeaderBitmap to prevent redundant changing of the bitmap if
  ; the user clicks the back button
  StrCpy $hHeaderBitmap ""

  !insertmacro InitInstallOptionsFile "unconfirm.ini"
FunctionEnd

Function .onGUIEnd
  ${OnEndCommon}
FunctionEnd

Function un.onGUIEnd
  ${un.OnEndCommon}
FunctionEnd
