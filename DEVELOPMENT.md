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
