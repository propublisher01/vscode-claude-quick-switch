# Changelog

## 1.4.0

- **Usage in the status bar**: the active account's usage (`· 42%`), yellow from 80%, red from 95%; the tooltip shows the 5-hour session and weekly limits with their reset times, and the plan.
- **Usage and plan in the account list**, with the age of the last known value for inactive accounts.
- **Limit alert**: at 90% of a limit, offers to switch to the least used account in one click (`claudeQuickSwitch.usageAlertThreshold`).
- New settings `showUsageInStatusBar` and `usageRefreshMinutes` (`0` = no network request, use Claude Code's cache only).

## 1.3.0

- **Switch to Previous Account** (`Ctrl+Alt+Shift+C`, `Cmd+Alt+Shift+C` on macOS): toggles between your last two accounts without opening the list.
- Rename and delete accounts right from the list (✏️ / 🗑 buttons), plus a new **Rename Profile** command.
- Automated tests (`npm test`).

## 1.1.0

- macOS support: credentials are read from and written to the `Claude Code-credentials` item of the login Keychain, where Claude Code stores them on macOS.

## 1.0.0

- First public release.
- Switch between saved Claude Code accounts from the status bar.
- *Add account*: runs `claude auth login`, detects the sign-in and saves the new profile.
- Profiles stored in SecretStorage; the active profile is re-saved before each switch.
- English and French interface.
