# Development

```bash
npm install
npm run compile   # or F5 in VS Code to launch an Extension Development Host
npm run package   # builds the .vsix
```

Local install: `code --install-extension claude-quick-switch-<version>.vsix`

## Translations

- `package.nls.json` / `package.nls.fr.json`: command titles, settings, display name.
- `l10n/bundle.l10n.fr.json`: runtime strings (`vscode.l10n.t(...)`). Keys are the English strings used in `src/extension.ts`.

## Publishing to the VS Code Marketplace

One-time setup:
1. Create an [Azure DevOps Personal Access Token](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate) with the "Marketplace (Manage)" scope
2. `npx vsce login proPublisher` then paste the token

Then:
```bash
npm run publish
```
The `version` in `package.json` must be bumped for every publish (`npx vsce publish patch|minor`).

## Publishing to Open VSX (Cursor, VSCodium, Windsurf…)

One-time setup:
1. Sign in at [open-vsx.org](https://open-vsx.org) with GitHub, link an Eclipse account and sign the Publisher Agreement (profile page)
2. Create an access token (Settings → Access Tokens)
3. Create the namespace: `npx ovsx create-namespace proPublisher -p <token>`

Then (the token is read from the `OVSX_PAT` environment variable):
```powershell
$env:OVSX_PAT = "<token>"
npm run publish:ovsx     # Open VSX only
npm run publish:all      # Marketplace + Open VSX
```
