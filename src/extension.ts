import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

/** Profile metadata (non-sensitive, kept in globalState). */
interface ProfileMeta {
  name: string;
  email: string;
  organization?: string;
  savedAt: number;
}

/** Sensitive profile data (kept in SecretStorage). */
interface ProfileSecret {
  credentials: string; // raw content of .credentials.json (or of the macOS Keychain item)
  oauthAccount: unknown; // oauthAccount block of .claude.json
}

const CONFIG_SECTION = 'claudeQuickSwitch';
const PROFILES_KEY = 'profiles';
const BACKUP_KEY = 'backup:last';
const secretKey = (name: string) => `profile:${name}`;

let statusItem: vscode.StatusBarItem;

// ---------------------------------------------------------------------------
// Claude Code files
// ---------------------------------------------------------------------------

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function credentialsPath(): string {
  return path.join(configDir(), '.credentials.json');
}

function globalConfigPath(): string {
  // With CLAUDE_CONFIG_DIR, .claude.json lives in that folder; otherwise in the home folder.
  return process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(os.homedir(), '.claude.json');
}

function readGlobalConfig(): Record<string, any> {
  return JSON.parse(fs.readFileSync(globalConfigPath(), 'utf8'));
}

// On macOS, Claude Code keeps the OAuth tokens in the login Keychain instead of .credentials.json.
const useKeychain = process.platform === 'darwin';

function keychainService(): string {
  // With CLAUDE_CONFIG_DIR, Claude Code suffixes the service name with a hash of that folder.
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir
    ? `Claude Code-credentials-${crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8)}`
    : 'Claude Code-credentials';
}

/** Where the credentials live, for error messages. */
function credentialsLocation(): string {
  return useKeychain ? `Keychain "${keychainService()}"` : credentialsPath();
}

function readCredentialsRaw(): string {
  try {
    if (useKeychain) {
      return execFileSync(
        'security',
        ['find-generic-password', '-a', os.userInfo().username, '-s', keychainService(), '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).replace(/\n$/, '');
    }
    return fs.readFileSync(credentialsPath(), 'utf8');
  } catch {
    return '';
  }
}

function writeCredentialsRaw(content: string): void {
  if (useKeychain) {
    // Sent hex-encoded through stdin (`security -i`) so the tokens never show up in the process list.
    const hex = Buffer.from(content, 'utf8').toString('hex');
    const cmd = `add-generic-password -U -a "${os.userInfo().username}" -s "${keychainService()}" -X ${hex}\n`;
    execFileSync('security', ['-i'], { input: cmd, stdio: ['pipe', 'ignore', 'pipe'] });
    if (readCredentialsRaw() !== content) {
      throw new Error(vscode.l10n.t('Could not write the credentials to the macOS Keychain.'));
    }
    return;
  }
  fs.mkdirSync(configDir(), { recursive: true });
  writeFileAtomic(credentialsPath(), content);
}

/** Atomic write: temp file, then rename. */
function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readCurrentAccount(): { email: string; organization?: string; oauthAccount: any } | undefined {
  try {
    const oauthAccount = readGlobalConfig().oauthAccount;
    if (!oauthAccount?.emailAddress) {
      return undefined;
    }
    return { email: oauthAccount.emailAddress, organization: oauthAccount.organizationName, oauthAccount };
  } catch {
    return undefined;
  }
}

const sameAccount = (a: { email: string; organization?: string }, b: { email: string; organization?: string }) =>
  a.email === b.email && a.organization === b.organization;

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

function getProfiles(ctx: vscode.ExtensionContext): ProfileMeta[] {
  return ctx.globalState.get<ProfileMeta[]>(PROFILES_KEY, []);
}

async function setProfiles(ctx: vscode.ExtensionContext, profiles: ProfileMeta[]): Promise<void> {
  await ctx.globalState.update(PROFILES_KEY, profiles);
}

/** Stores the currently signed-in account as profile `name`. */
async function captureCurrent(ctx: vscode.ExtensionContext, name: string): Promise<ProfileMeta> {
  const account = readCurrentAccount();
  if (!account) {
    throw new Error(vscode.l10n.t('No Claude account signed in. Sign in first with /login in Claude Code.'));
  }
  const credentials = readCredentialsRaw();
  if (!credentials) {
    throw new Error(vscode.l10n.t('Credentials file not found: {0}', credentialsLocation()));
  }

  const secret: ProfileSecret = { credentials, oauthAccount: account.oauthAccount };
  await ctx.secrets.store(secretKey(name), JSON.stringify(secret));

  const meta: ProfileMeta = { name, email: account.email, organization: account.organization, savedAt: Date.now() };
  const profiles = getProfiles(ctx).filter(p => p.name !== name);
  profiles.push(meta);
  profiles.sort((a, b) => a.name.localeCompare(b.name));
  await setProfiles(ctx, profiles);
  return meta;
}

/**
 * Updates the profile matching the active account, so tokens refreshed by Claude Code
 * since the last save are not lost.
 */
async function refreshActiveProfile(ctx: vscode.ExtensionContext): Promise<void> {
  const account = readCurrentAccount();
  if (!account) {
    return;
  }
  const match = getProfiles(ctx).find(p => sameAccount(p, account));
  if (match) {
    await captureCurrent(ctx, match.name);
  }
}

async function applyProfile(ctx: vscode.ExtensionContext, profile: ProfileMeta): Promise<void> {
  const raw = await ctx.secrets.get(secretKey(profile.name));
  if (!raw) {
    throw new Error(vscode.l10n.t('Data for profile "{0}" not found. Save it again.', profile.name));
  }
  const secret: ProfileSecret = JSON.parse(raw);

  // Safety backup of the current sign-in, kept in SecretStorage (never in plain text on disk).
  const config = readGlobalConfig();
  const backup: ProfileSecret = { credentials: readCredentialsRaw(), oauthAccount: config.oauthAccount };
  await ctx.secrets.store(BACKUP_KEY, JSON.stringify(backup));

  // Only oauthAccount is replaced in .claude.json; the rest of the config is kept.
  config.oauthAccount = secret.oauthAccount;
  writeCredentialsRaw(secret.credentials);
  writeFileAtomic(globalConfigPath(), JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Asks for a name and saves the signed-in account. Returns the profile, or undefined if cancelled. */
async function promptAndSave(ctx: vscode.ExtensionContext, title: string): Promise<ProfileMeta | undefined> {
  const account = readCurrentAccount();
  if (!account) {
    vscode.window.showErrorMessage(vscode.l10n.t('No Claude account signed in. Sign in first with /login in Claude Code.'));
    return;
  }
  const existing = getProfiles(ctx).find(p => sameAccount(p, account));
  const label = account.organization ? `${account.email} (${account.organization})` : account.email;
  const name = await vscode.window.showInputBox({
    title,
    prompt: vscode.l10n.t('Profile name for {0}', label),
    value: existing?.name ?? account.email.split('@')[0],
    ignoreFocusOut: true,
    validateInput: v => (v.trim() ? undefined : vscode.l10n.t('Name cannot be empty')),
  });
  if (!name) {
    return;
  }
  try {
    const meta = await captureCurrent(ctx, name.trim());
    updateStatus(ctx);
    return meta;
  } catch (e) {
    vscode.window.showErrorMessage((e as Error).message);
  }
}

async function cmdSaveCurrent(ctx: vscode.ExtensionContext): Promise<void> {
  const meta = await promptAndSave(ctx, vscode.l10n.t('Save current Claude account'));
  if (meta) {
    vscode.window.showInformationMessage(vscode.l10n.t('Profile "{0}" saved ({1}).', meta.name, meta.email));
  }
}

async function offerReload(message: string): Promise<void> {
  const mode = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('reloadAfterSwitch', 'ask');
  if (mode === 'always') {
    vscode.commands.executeCommand('workbench.action.reloadWindow');
  } else if (mode === 'ask') {
    const reload = vscode.l10n.t('Reload');
    const choice = await vscode.window.showInformationMessage(
      `${message} ${vscode.l10n.t('Reload the window so Claude Code uses it?')}`,
      reload,
    );
    if (choice === reload) {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } else {
    vscode.window.showInformationMessage(message);
  }
}

async function cmdSwitch(ctx: vscode.ExtensionContext): Promise<void> {
  const profiles = getProfiles(ctx);
  const current = readCurrentAccount();

  type Item = vscode.QuickPickItem & { profile?: ProfileMeta; action?: 'add' | 'save' };
  const items: Item[] = profiles.map(p => {
    const active = current && sameAccount(p, current);
    return {
      label: `${active ? '$(check)' : '$(account)'} ${p.name}`,
      description: p.email,
      detail: p.organization,
      profile: p,
    };
  });
  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: `$(add) ${vscode.l10n.t('Add account…')}`, action: 'add' },
  );
  if (current && !profiles.some(p => sameAccount(p, current))) {
    items.push({ label: `$(save) ${vscode.l10n.t('Save current account…')}`, description: current.email, action: 'save' });
  }

  const pick = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('Switch Claude account'),
    placeHolder: profiles.length ? vscode.l10n.t('Pick an account') : vscode.l10n.t('No profile yet — add or save an account'),
  });
  if (!pick) {
    return;
  }
  if (pick.action === 'add') {
    return cmdAdd(ctx);
  }
  if (pick.action === 'save') {
    return cmdSaveCurrent(ctx);
  }
  const target = pick.profile!;
  if (current && sameAccount(target, current)) {
    vscode.window.showInformationMessage(vscode.l10n.t('Already signed in to "{0}".', target.name));
    return;
  }

  try {
    await refreshActiveProfile(ctx);
    await applyProfile(ctx, target);
  } catch (e) {
    vscode.window.showErrorMessage(vscode.l10n.t('Account switch failed: {0}', (e as Error).message));
    return;
  }
  updateStatus(ctx);
  await offerReload(vscode.l10n.t('Claude account: {0} ({1}).', target.name, target.email));
}

async function cmdDelete(ctx: vscode.ExtensionContext): Promise<void> {
  const profiles = getProfiles(ctx);
  if (!profiles.length) {
    vscode.window.showInformationMessage(vscode.l10n.t('No saved profile.'));
    return;
  }
  const pick = await vscode.window.showQuickPick(
    profiles.map(p => ({ label: p.name, description: p.email, profile: p })),
    { title: vscode.l10n.t('Delete a Claude profile') },
  );
  if (!pick) {
    return;
  }
  const del = vscode.l10n.t('Delete');
  const confirm = await vscode.window.showWarningMessage(
    vscode.l10n.t('Delete profile "{0}"? (the currently signed-in account is not signed out)', pick.profile.name),
    { modal: true },
    del,
  );
  if (confirm !== del) {
    return;
  }
  await ctx.secrets.delete(secretKey(pick.profile.name));
  await setProfiles(ctx, profiles.filter(p => p.name !== pick.profile.name));
  updateStatus(ctx);
}

// ---------------------------------------------------------------------------
// Adding an account (claude auth login)
// ---------------------------------------------------------------------------

/** Path of the claude CLI: setting, else the binary shipped with the Claude Code extension, else PATH. */
function findClaudeBinary(): string | undefined {
  const configured = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('claudePath', '').trim();
  if (configured) {
    return configured;
  }
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (ext) {
    const bin = path.join(ext.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (fs.existsSync(bin)) {
      return bin;
    }
  }
  return undefined;
}

async function cmdAdd(ctx: vscode.ExtensionContext): Promise<void> {
  // 1. Make sure the current account is saved (otherwise it would be lost).
  const current = readCurrentAccount();
  if (current) {
    if (getProfiles(ctx).some(p => sameAccount(p, current))) {
      await refreshActiveProfile(ctx);
    } else {
      const save = vscode.l10n.t('Save');
      const skip = vscode.l10n.t('Continue without saving');
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('The current account ({0}) is not saved. Save it before adding another one?', current.email),
        { modal: true },
        save,
        skip,
      );
      if (!choice) {
        return;
      }
      if (choice === save && !(await promptAndSave(ctx, vscode.l10n.t('Save current Claude account')))) {
        return;
      }
    }
  }

  // 2. Run "claude auth login" in a terminal (opens the browser).
  const before = { credentials: readCredentialsRaw(), account: current };
  const bin = findClaudeBinary();
  const terminal = bin
    ? vscode.window.createTerminal({ name: 'Claude login', shellPath: bin, shellArgs: ['auth', 'login'] })
    : vscode.window.createTerminal({ name: 'Claude login' });
  if (!bin) {
    terminal.sendText('claude auth login');
  }
  terminal.show();

  // 3. Wait for the sign-in to complete.
  const loggedIn = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Sign in to the new Claude account in your browser…'),
      cancellable: true,
    },
    (_progress, token) =>
      new Promise<boolean>(resolve => {
        let done = false;
        let credsChangedAt = 0;
        const finish = (ok: boolean) => {
          if (done) {
            return;
          }
          done = true;
          clearInterval(interval);
          clearTimeout(timeout);
          closeSub.dispose();
          resolve(ok);
        };
        const interval = setInterval(() => {
          if (token.isCancellationRequested) {
            return finish(false);
          }
          const account = readCurrentAccount();
          const credsChanged = readCredentialsRaw() !== before.credentials;
          if (credsChanged && !credsChangedAt) {
            credsChangedAt = Date.now();
          }
          if (!account || !credsChanged) {
            return;
          }
          // New account detected, or same account signed in again (login finished or grace period elapsed).
          const otherAccount = !before.account || !sameAccount(account, before.account);
          if (otherAccount || terminal.exitStatus !== undefined || Date.now() - credsChangedAt > 5000) {
            finish(true);
          }
        }, 1000);
        const closeSub = vscode.window.onDidCloseTerminal(t => {
          if (t === terminal) {
            // Last check, giving the files time to be written.
            setTimeout(() => finish(readCredentialsRaw() !== before.credentials && !!readCurrentAccount()), 1500);
          }
        });
        const timeout = setTimeout(() => finish(false), 10 * 60 * 1000);
      }),
  );

  if (!loggedIn) {
    vscode.window.showWarningMessage(vscode.l10n.t('Adding the account was cancelled, or no sign-in was detected.'));
    return;
  }
  terminal.dispose();

  // 4. Save the new account.
  const meta = await promptAndSave(ctx, vscode.l10n.t('New Claude account signed in'));
  updateStatus(ctx);
  if (meta) {
    await offerReload(vscode.l10n.t('Account "{0}" ({1}) added and active.', meta.name, meta.email));
  }
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function updateStatus(ctx: vscode.ExtensionContext): void {
  const account = readCurrentAccount();
  if (!account) {
    statusItem.text = `$(sparkle) ${vscode.l10n.t('Claude: signed out')}`;
    statusItem.tooltip = vscode.l10n.t('No Claude account signed in');
  } else {
    const profile = getProfiles(ctx).find(p => sameAccount(p, account));
    statusItem.text = `$(sparkle) Claude: ${profile?.name ?? account.email}`;
    statusItem.tooltip = new vscode.MarkdownString(
      `**${vscode.l10n.t('Claude account')}**\n\n${account.email}${account.organization ? `\n\n${account.organization}` : ''}` +
        `${profile ? '' : `\n\n_${vscode.l10n.t('Not saved')}_`}\n\n${vscode.l10n.t('Click to switch account')}`,
    );
  }
  statusItem.show();
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(ctx: vscode.ExtensionContext): void {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'claudeQuickSwitch.switch';
  ctx.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('claudeQuickSwitch.switch', () => cmdSwitch(ctx)),
    vscode.commands.registerCommand('claudeQuickSwitch.add', () => cmdAdd(ctx)),
    vscode.commands.registerCommand('claudeQuickSwitch.saveCurrent', () => cmdSaveCurrent(ctx)),
    vscode.commands.registerCommand('claudeQuickSwitch.delete', () => cmdDelete(ctx)),
  );

  // Refresh the status bar when the account changes outside the extension (/login, /logout, another window).
  let timer: NodeJS.Timeout | undefined;
  const onChange = () => {
    clearTimeout(timer);
    timer = setTimeout(() => updateStatus(ctx), 500);
  };
  fs.watchFile(globalConfigPath(), { interval: 3000 }, onChange);
  ctx.subscriptions.push({ dispose: () => fs.unwatchFile(globalConfigPath(), onChange) });

  updateStatus(ctx);
}

export function deactivate(): void {}
