# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Aequera branding (selected with --with-branding=browser/branding/aequera;
# the identity options that go with it are in tools/build/mozconfig.branding).
MOZ_APP_DISPLAYNAME=Aequera
# Leaf of the mac bundle identifier. toolkit/moz.configure prefixes it with
# --with-distribution-id (org.aequera in mozconfig.branding), so the built
# app is org.aequera.browser: no org.mozilla.* bundle, helper, or updater
# identity is ever claimed. Matches the Linux desktop/portal identity
# (configs/defaults/branding.toml dbus_service).
MOZ_MACBUNDLE_ID=browser
