; Compile the production guards into a disposable test executable. No registry
; changes, process termination or real application installation occurs here.
Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "EpiLib installer ownership regression"
OutFile "${HARNESS_EXE}"
!include LogicLib.nsh
!define InstallMarker "epilib-install.ini"
!include "../../app/win/installer/isolation.nsh"

Section
  !ifdef REQUIRE_OWNED
    !insertmacro EpiLibRequireOwnedInstall
  !else
    !insertmacro EpiLibCheckInstallDirectory
  !endif
  ; Only successful guard completion may create this test result. Abort paths
  ; leave every input file unchanged and produce no result file.
  FileOpen $0 "${HARNESS_RESULT}" w
  FileWrite $0 "passed"
  FileClose $0
SectionEnd
