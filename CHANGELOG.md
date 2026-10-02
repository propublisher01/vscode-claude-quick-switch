# Changelog

## 1.1.0

- macOS support: credentials are read from and written to the `Claude Code-credentials` item of the login Keychain, where Claude Code stores them on macOS.

## 1.0.0

- First public release.
- Switch between saved Claude Code accounts from the status bar.
- *Add account*: runs `claude auth login`, detects the sign-in and saves the new profile.
- Profiles stored in SecretStorage; the active profile is re-saved before each switch.
- English and French interface.
