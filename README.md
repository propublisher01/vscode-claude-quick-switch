# Claude Quick Switch

Switch between multiple **Claude Code** accounts in two clicks, right from the VS Code status bar.

Personal and work subscriptions, several organizations, a second account for when you hit your usage limit: no more `/logout` → `/login` → browser → back again.

## Features

- **One-click switch**: click `✨ Claude: <profile>` in the status bar and pick an account.
- **Add an account without leaving VS Code**: *Add account…* runs `claude auth login` in a terminal, detects when you're signed in in the browser, and saves the new profile.
- **Tokens stay secure**: saved accounts are stored in VS Code's SecretStorage (your OS keychain / Windows Credential Manager), never in plain text.
- **Tokens stay fresh**: before each switch, the active profile is re-saved so tokens refreshed by Claude Code are not lost.
- **Non-intrusive**: only the sign-in data is swapped; the rest of your Claude Code configuration is untouched.
- English and French interface (follows VS Code's display language).

## Usage

1. Click `✨ Claude: …` in the status bar (bottom right).
2. The first time, choose **Save current account…** to save the account you're signed in with.
3. Choose **Add account…** to sign in with another account in your browser. It is saved automatically once signed in.
4. From then on, pick any profile in the list to switch, then reload the window.

Commands (`Ctrl+Shift+P`):

| Command | Description |
| --- | --- |
| `Claude: Switch Account` | Pick a saved account |
| `Claude: Add Account` | Sign in with a new account and save it |
| `Claude: Save Current Account` | Save (or update) the signed-in account |
| `Claude: Delete Profile` | Remove a saved account |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeQuickSwitch.reloadAfterSwitch` | `ask` | `ask`, `always` or `never` reload the window after switching. A reload is needed for Claude Code to use the new account. |
| `claudeQuickSwitch.claudePath` | *(empty)* | Path of the `claude` CLI used by *Add account*. Empty = the binary shipped with the Claude Code extension, otherwise `claude` from the PATH. |

## How it works

Claude Code keeps its sign-in in two files:

- `~/.claude/.credentials.json`: OAuth tokens (on macOS: the `Claude Code-credentials` item of the login Keychain)
- `~/.claude.json`: the `oauthAccount` key (account information)

Each profile keeps a copy of this data in SecretStorage and restores it when you switch. Only the `oauthAccount` key of `~/.claude.json` is modified. `CLAUDE_CONFIG_DIR` is supported.

## Limitations

- A Claude Code session that is already open keeps using the previous account until the window is reloaded (or `claude` is restarted in the terminal).
- If a profile is not used for a long time, its refresh token may expire: sign in again and save it again.
- Relies on Claude Code's internal file format, which may change in future versions.

## Disclaimer

This is an unofficial extension. It is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic, PBC.

## License

[MIT](LICENSE)
