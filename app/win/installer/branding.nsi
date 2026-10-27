# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# NSIS branding defines for unofficial builds.
# The official release build branding.nsi is located in other-license/branding/firefox/
# The nightly build branding.nsi is located in browser/installer/windows/nsis/

# Installer ownership is separate from the retained Mozilla runtime identity.
# Never discover or upgrade official installations through EpiLib's registry keys.
!define BrandFullNameInternal "EpiLib"
!define CompanyName           "EpiLib contributors"
!define URLInfoAbout          "https://epilib.org/"
!define URLUpdateInfo         "https://epilib.org/downloads"
