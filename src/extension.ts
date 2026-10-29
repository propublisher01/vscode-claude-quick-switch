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
  accountUuid?: string; // missing on profiles saved before 1.2.0 until migrated
  organizationUuid?: string;
  refreshExpiresAt?: number; // when the saved refresh token expires (ms epoch)
  savedAt: number;
}

/** Identity of an account, from .claude.json or from a profile. */
interface AccountId {
  email: string;
  organization?: string;
  accountUuid?: string;
  organizationUuid?: string;
}

/** Sensitive profile data (kept in SecretStorage). */
interface ProfileSecret {
  credentials: string; // raw content of .credentials.json (or of the macOS Keychain item)
  oauthAccount: unknown; // oauthAccount block of .claude.json
}

const CONFIG_SECTION = 'claudeQuickSwitch';
const PROFILES_KEY = 'profiles';
const BACKUP_KEY = 'backup:last';
const PREVIOUS_KEY = 'previousProfile';
const secretKey = (name: string) => `profile:${name}`;

let statusItem: vscode.StatusBarItem;
/** True while "Add account" waits for `claude auth login` (the sign-in is briefly inconsistent then). */
let loginInProgress = false;

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

function accountIdOf(oauthAccount: any): AccountId {
  return {
    email: oauthAccount.emailAddress,
    organization: oauthAccount.organizationName,
    accountUuid: oauthAccount.accountUuid,
    organizationUuid: oauthAccount.organizationUuid,
  };
}

function readCurrentAccount(): (AccountId & { oauthAccount: any }) | undefined {
  try {
    const oauthAccount = readGlobalConfig().oauthAccount;
    if (!oauthAccount?.emailAddress) {
      return undefined;
    }
    return { ...accountIdOf(oauthAccount), oauthAccount };
  } catch {
    return undefined;
  }
}

/** Compares by UUIDs when both sides have them (they never change), otherwise by email + organization name. */
function sameAccount(a: AccountId, b: AccountId): boolean {
  if (a.accountUuid && b.accountUuid) {
    return a.accountUuid === b.accountUuid && a.organizationUuid === b.organizationUuid;
  }
  return a.email === b.email && a.organization === b.organization;
}

/** Non-sensitive fields of a credentials payload. */
function parseCredentials(raw: string): { organizationUuid?: string; refreshExpiresAt?: number } {
  try {
    const json = JSON.parse(raw);
    return { organizationUuid: json.organizationUuid, refreshExpiresAt: json.claudeAiOauth?.refreshTokenExpiresAt };
  } catch {
    return {};
  }
}

/**
 * Current sign-in. `mismatch` is true when the tokens belong to another organization than the account
 * in .claude.json: typically another Claude Code session (other window, terminal) still running with the
 * previous account has refreshed and rewritten its own tokens after a switch.
 */
function readSignIn() {
  const account = readCurrentAccount();
  const credentials = readCredentialsRaw();
  const creds = parseCredentials(credentials);
  const mismatch = !!(account?.organizationUuid && creds.organizationUuid && account.organizationUuid !== creds.organizationUuid);
  return { account, credentials, creds, mismatch };
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

function getProfiles(ctx: vscode.ExtensionContext): ProfileMeta[] {
  return ctx.globalState.get<ProfileMeta[]>(PROFILES_KEY, []);
}

async function setProfiles(ctx: vscode.ExtensionContext, profiles: ProfileMeta[]): Promise<void> {
  await ctx.globalState.update(PROFILES_KEY, profiles);
}

/** Saves a profile's secret and metadata (replacing any profile with the same name). */
async function storeProfile(ctx: vscode.ExtensionContext, name: string, secret: ProfileSecret): Promise<ProfileMeta> {
  await ctx.secrets.store(secretKey(name), JSON.stringify(secret));
  const meta: ProfileMeta = {
    name,
    ...accountIdOf(secret.oauthAccount),
    refreshExpiresAt: parseCredentials(secret.credentials).refreshExpiresAt,
    savedAt: Date.now(),
  };
  const profiles = getProfiles(ctx).filter(p => p.name !== name);
  profiles.push(meta);
  profiles.sort((a, b) => a.name.localeCompare(b.name));
  await setProfiles(ctx, profiles);
  return meta;
}

/** Stores the currently signed-in account as profile `name`. */
async function captureCurrent(ctx: vscode.ExtensionContext, name: string): Promise<ProfileMeta> {
  const { account, credentials, mismatch } = readSignIn();
  if (!account) {
    throw new Error(vscode.l10n.t('No Claude account signed in. Sign in first with /login in Claude Code.'));
  }
  if (!credentials) {
    throw new Error(vscode.l10n.t('Credentials file not found: {0}', credentialsLocation()));
  }
  if (mismatch) {
    // Saving now would file another account's tokens under this profile.
    throw new Error(vscode.l10n.t('The Claude sign-in is inconsistent (tokens of another account). Switch account again first.'));
  }
  return storeProfile(ctx, name, { credentials, oauthAccount: account.oauthAccount });
}

/**
 * Updates the profile matching the active account, so tokens refreshed by Claude Code
 * since the last save are not lost.
 */
async function refreshActiveProfile(ctx: vscode.ExtensionContext): Promise<void> {
  const { account, mismatch } = readSignIn();
  if (!account || mismatch) {
    return;
  }
  const match = getProfiles(ctx).find(p => sameAccount(p, account));
  if (match) {
    await captureCurrent(ctx, match.name);
  }
}

async function readProfileSecret(ctx: vscode.ExtensionContext, name: string): Promise<ProfileSecret | undefined> {
  const raw = await ctx.secrets.get(secretKey(name));
  return raw ? JSON.parse(raw) : undefined;
}

/** Fills the UUIDs and expiry of profiles saved before 1.2.0 (they only had email + organization name). */
async function migrateProfiles(ctx: vscode.ExtensionContext): Promise<void> {
  const profiles = getProfiles(ctx);
  let changed = false;
  for (const p of profiles) {
    if (p.accountUuid) {
      continue;
    }
    const secret = await readProfileSecret(ctx, p.name);
    if (!secret) {
      continue;
    }
    const id = accountIdOf(secret.oauthAccount);
    p.accountUuid = id.accountUuid;
    p.organizationUuid = id.organizationUuid;
    p.refreshExpiresAt = parseCredentials(secret.credentials).refreshExpiresAt;
    changed = true;
  }
  if (changed) {
    await setProfiles(ctx, profiles);
  }
}

/** Expiry of a profile's sign-in: live from Claude Code for the active account, else as saved. */
function profileExpiry(p: ProfileMeta, active: boolean): number | undefined {
  return active ? readSignIn().creds.refreshExpiresAt ?? p.refreshExpiresAt : p.refreshExpiresAt;
}

const DAY = 24 * 60 * 60 * 1000;

function isExpired(expiresAt: number | undefined): boolean {
  return !!expiresAt && expiresAt <= Date.now();
}

/** Short text for the account list, e.g. "Sign-in valid for 5 days". */
function describeExpiry(expiresAt: number | undefined): string | undefined {
  if (!expiresAt) {
    return undefined;
  }
  const left = expiresAt - Date.now();
  if (left <= 0) {
    return `$(error) ${vscode.l10n.t('Sign-in expired — sign in again')}`;
  }
  if (left < DAY) {
    return `$(warning) ${vscode.l10n.t('Sign-in expires in {0} h', Math.max(1, Math.floor(left / (60 * 60 * 1000))))}`;
  }
  const days = Math.floor(left / DAY);
  return days < 2
    ? `$(warning) ${vscode.l10n.t('Sign-in expires in {0} day', days)}`
    : vscode.l10n.t('Sign-in valid for {0} days', days);
}

async function applyProfile(ctx: vscode.ExtensionContext, profile: ProfileMeta): Promise<void> {
  const secret = await readProfileSecret(ctx, profile.name);
  if (!secret) {
    throw new Error(vscode.l10n.t('Data for profile "{0}" not found. Save it again.', profile.name));
  }

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
  const mode = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('reloadAfterSwitch', 'never');
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

/** Switches to `target`: checks expiry, keeps the active profile's fresh tokens, then swaps the sign-in. */
async function switchTo(ctx: vscode.ExtensionContext, target: ProfileMeta): Promise<void> {
  const current = readCurrentAccount();
  if (current && sameAccount(target, current)) {
    vscode.window.showInformationMessage(vscode.l10n.t('Already signed in to "{0}".', target.name));
    return;
  }
  if (isExpired(target.refreshExpiresAt)) {
    const signIn = vscode.l10n.t('Sign in again');
    const anyway = vscode.l10n.t('Switch anyway');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('The saved sign-in of "{0}" has expired. Sign in to this account again?', target.name),
      { modal: true },
      signIn,
      anyway,
    );
    if (choice === signIn) {
      return cmdAdd(ctx);
    }
    if (choice !== anyway) {
      return;
    }
  }

  const leaving = current && getProfiles(ctx).find(p => sameAccount(p, current));
  try {
    await refreshActiveProfile(ctx);
    await applyProfile(ctx, target);
  } catch (e) {
    vscode.window.showErrorMessage(vscode.l10n.t('Account switch failed: {0}', (e as Error).message));
    return;
  }
  if (leaving) {
    await ctx.globalState.update(PREVIOUS_KEY, leaving.name);
  }
  updateStatus(ctx);
  await offerReload(vscode.l10n.t('Claude account: {0} ({1}).', target.name, target.email));
}

async function cmdSwitch(ctx: vscode.ExtensionContext): Promise<void> {
  const profiles = getProfiles(ctx);
  const current = readCurrentAccount();

  const renameButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: vscode.l10n.t('Rename') };
  const deleteButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: vscode.l10n.t('Delete') };

  type Item = vscode.QuickPickItem & { profile?: ProfileMeta; action?: 'add' | 'save' };
  const items: Item[] = profiles.map(p => {
    const active = !!current && sameAccount(p, current);
    return {
      label: `${active ? '$(check)' : '$(account)'} ${p.name}`,
      description: p.email,
      detail: [p.organization, describeExpiry(profileExpiry(p, active))].filter(Boolean).join('  ·  ') || undefined,
      buttons: [renameButton, deleteButton],
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

  const qp = vscode.window.createQuickPick<Item>();
  qp.title = vscode.l10n.t('Switch Claude account');
  qp.placeholder = profiles.length ? vscode.l10n.t('Pick an account') : vscode.l10n.t('No profile yet — add or save an account');
  qp.items = items;
  const { item, button } = await new Promise<{ item?: Item; button?: vscode.QuickInputButton }>(resolve => {
    qp.onDidAccept(() => resolve({ item: qp.selectedItems[0] }));
    qp.onDidTriggerItemButton(e => resolve({ item: e.item, button: e.button }));
    qp.onDidHide(() => resolve({}));
    qp.show();
  });
  qp.dispose();

  if (!item) {
    return;
  }
  if (button && item.profile) {
    // Rename / delete from the list, then reopen it.
    const done = button === renameButton ? await renameProfile(ctx, item.profile) : await deleteProfile(ctx, item.profile);
    return done ? cmdSwitch(ctx) : undefined;
  }
  if (item.action === 'add') {
    return cmdAdd(ctx);
  }
  if (item.action === 'save') {
    return cmdSaveCurrent(ctx);
  }
  return switchTo(ctx, item.profile!);
}

/** Toggles back to the account used before the last switch (or the only other one). */
async function cmdSwitchPrevious(ctx: vscode.ExtensionContext): Promise<void> {
  const current = readCurrentAccount();
  const others = getProfiles(ctx).filter(p => !current || !sameAccount(p, current));
  const previousName = ctx.globalState.get<string>(PREVIOUS_KEY);
  const target = others.find(p => p.name === previousName) ?? (others.length === 1 ? others[0] : undefined);
  return target ? switchTo(ctx, target) : cmdSwitch(ctx);
}

/** Lets the user pick a profile (for the palette commands). */
async function pickProfile(title: string, profiles: ProfileMeta[]): Promise<ProfileMeta | undefined> {
  if (!profiles.length) {
    vscode.window.showInformationMessage(vscode.l10n.t('No saved profile.'));
    return;
  }
  const pick = await vscode.window.showQuickPick(
    profiles.map(p => ({ label: p.name, description: p.email, profile: p })),
    { title },
  );
  return pick?.profile;
}

/** Renames a profile. Returns true when renamed. */
async function renameProfile(ctx: vscode.ExtensionContext, profile: ProfileMeta): Promise<boolean> {
  const profiles = getProfiles(ctx);
  const input = await vscode.window.showInputBox({
    title: vscode.l10n.t('Rename profile "{0}"', profile.name),
    value: profile.name,
    validateInput: v => {
      const name = v.trim();
      if (!name) {
        return vscode.l10n.t('Name cannot be empty');
      }
      return name !== profile.name && profiles.some(p => p.name === name)
        ? vscode.l10n.t('A profile named "{0}" already exists.', name)
        : undefined;
    },
  });
  const name = input?.trim();
  if (!name || name === profile.name) {
    return false;
  }
  const secret = await readProfileSecret(ctx, profile.name);
  if (secret) {
    await ctx.secrets.store(secretKey(name), JSON.stringify(secret));
  }
  await ctx.secrets.delete(secretKey(profile.name));
  await setProfiles(
    ctx,
    profiles.map(p => (p.name === profile.name ? { ...p, name } : p)).sort((a, b) => a.name.localeCompare(b.name)),
  );
  if (ctx.globalState.get<string>(PREVIOUS_KEY) === profile.name) {
    await ctx.globalState.update(PREVIOUS_KEY, name);
  }
  updateStatus(ctx);
  return true;
}

/** Deletes a profile after confirmation. Returns true when deleted. */
async function deleteProfile(ctx: vscode.ExtensionContext, profile: ProfileMeta): Promise<boolean> {
  const del = vscode.l10n.t('Delete');
  const confirm = await vscode.window.showWarningMessage(
    vscode.l10n.t('Delete profile "{0}"? (the currently signed-in account is not signed out)', profile.name),
    { modal: true },
    del,
  );
  if (confirm !== del) {
    return false;
  }
  await ctx.secrets.delete(secretKey(profile.name));
  await setProfiles(ctx, getProfiles(ctx).filter(p => p.name !== profile.name));
  if (ctx.globalState.get<string>(PREVIOUS_KEY) === profile.name) {
    await ctx.globalState.update(PREVIOUS_KEY, undefined);
  }
  updateStatus(ctx);
  return true;
}

async function cmdRename(ctx: vscode.ExtensionContext): Promise<void> {
  const profile = await pickProfile(vscode.l10n.t('Rename a Claude profile'), getProfiles(ctx));
  if (profile) {
    await renameProfile(ctx, profile);
  }
}

async function cmdDelete(ctx: vscode.ExtensionContext): Promise<void> {
  const profile = await pickProfile(vscode.l10n.t('Delete a Claude profile'), getProfiles(ctx));
  if (profile) {
    await deleteProfile(ctx, profile);
  }
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
  loginInProgress = true;
  try {
    await signInNewAccount(ctx, current);
  } finally {
    loginInProgress = false;
  }
}

async function signInNewAccount(ctx: vscode.ExtensionContext, current: AccountId | undefined): Promise<void> {
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
  const left = current && getProfiles(ctx).find(p => sameAccount(p, current));
  if (meta && left && !sameAccount(left, meta)) {
    await ctx.globalState.update(PREVIOUS_KEY, left.name);
  }
  if (meta) {
    await offerReload(vscode.l10n.t('Account "{0}" ({1}) added and active.', meta.name, meta.email));
  }
}

// ---------------------------------------------------------------------------
// Sign-in overwritten by another Claude Code session
// ---------------------------------------------------------------------------

/** Mismatch already reported (account org | tokens org), so the same one is not reported twice. */
let reportedMismatch: string | undefined;
/** A mismatch was seen while this window was not focused: report it on focus (avoids one popup per window). */
let pendingCheck = false;

async function checkSignIn(ctx: vscode.ExtensionContext): Promise<void> {
  if (loginInProgress) {
    return;
  }
  const { account, credentials, creds, mismatch } = readSignIn();
  if (!mismatch || !account) {
    reportedMismatch = undefined;
    return;
  }
  const key = `${account.organizationUuid}|${creds.organizationUuid}`;
  if (key === reportedMismatch) {
    return;
  }
  if (!vscode.window.state.focused) {
    pendingCheck = true;
    return;
  }
  reportedMismatch = key;

  const profiles = getProfiles(ctx);
  const owners = profiles.filter(p => p.organizationUuid === creds.organizationUuid);
  const owner = owners.length === 1 ? owners[0] : undefined;
  const shown = profiles.find(p => sameAccount(p, account));

  // These fresh tokens belong to `owner`; the ones saved in its profile may already have been rotated out.
  const ownerSecret = owner && (await readProfileSecret(ctx, owner.name));
  if (owner && ownerSecret) {
    await storeProfile(ctx, owner.name, { credentials, oauthAccount: ownerSecret.oauthAccount });
  }

  const useShown = shown && vscode.l10n.t('Use "{0}"', shown.name);
  const useOwner = owner && ownerSecret && vscode.l10n.t('Use "{0}"', owner.name);
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      'Another Claude Code session (another window or a terminal) is still signed in to {0} and has overwritten the sign-in. Close it, then choose the account to use.',
      owner ? `"${owner.name}"` : vscode.l10n.t('another account'),
    ),
    ...[useShown, useOwner].filter((x): x is string => !!x),
  );
  try {
    if (choice && choice === useShown) {
      await applyProfile(ctx, shown!);
      updateStatus(ctx);
      await offerReload(vscode.l10n.t('Claude account: {0} ({1}).', shown!.name, shown!.email));
    } else if (choice && choice === useOwner) {
      // Keep the tokens as they are and make .claude.json match them.
      const config = readGlobalConfig();
      config.oauthAccount = ownerSecret!.oauthAccount;
      writeFileAtomic(globalConfigPath(), JSON.stringify(config, null, 2));
      updateStatus(ctx);
      await offerReload(vscode.l10n.t('Claude account: {0} ({1}).', owner!.name, owner!.email));
    }
  } catch (e) {
    vscode.window.showErrorMessage(vscode.l10n.t('Account switch failed: {0}', (e as Error).message));
  }
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function updateStatus(ctx: vscode.ExtensionContext): void {
  const { account, mismatch } = readSignIn();
  statusItem.backgroundColor = undefined;
  if (!account) {
    statusItem.text = `$(sparkle) ${vscode.l10n.t('Claude: signed out')}`;
    statusItem.tooltip = vscode.l10n.t('No Claude account signed in');
  } else {
    const profile = getProfiles(ctx).find(p => sameAccount(p, account));
    statusItem.text = `${mismatch ? '$(warning)' : '$(sparkle)'} Claude: ${profile?.name ?? account.email}`;
    const warning = mismatch
      ? `\n\n$(warning) ${vscode.l10n.t('Inconsistent sign-in: another Claude Code session has overwritten the tokens. Switch account to fix it.')}`
      : '';
    statusItem.tooltip = new vscode.MarkdownString(
      `**${vscode.l10n.t('Claude account')}**\n\n${account.email}${account.organization ? `\n\n${account.organization}` : ''}` +
        `${profile ? '' : `\n\n_${vscode.l10n.t('Not saved')}_`}${warning}\n\n${vscode.l10n.t('Click to switch account')}`,
      true,
    );
    if (mismatch) {
      statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
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
    vscode.commands.registerCommand('claudeQuickSwitch.switchPrevious', () => cmdSwitchPrevious(ctx)),
    vscode.commands.registerCommand('claudeQuickSwitch.rename', () => cmdRename(ctx)),
    vscode.commands.registerCommand('claudeQuickSwitch.delete', () => cmdDelete(ctx)),
  );

  // Refresh the status bar when the account changes outside the extension (/login, /logout, another window),
  // and report tokens overwritten by another session. Writes to the macOS Keychain touch its database file.
  let timer: NodeJS.Timeout | undefined;
  const onChange = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      updateStatus(ctx);
      if (readSignIn().mismatch) {
        // A sign-in writes the tokens then .claude.json: only report a mismatch that lasts.
        setTimeout(() => checkSignIn(ctx), 3000);
      }
    }, 500);
  };
  const watched = [
    globalConfigPath(),
    useKeychain ? path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db') : credentialsPath(),
  ];
  for (const file of watched) {
    fs.watchFile(file, { interval: 3000 }, onChange);
    ctx.subscriptions.push({ dispose: () => fs.unwatchFile(file, onChange) });
  }
  ctx.subscriptions.push(
    vscode.window.onDidChangeWindowState(state => {
      if (state.focused && pendingCheck) {
        pendingCheck = false;
        checkSignIn(ctx);
      }
    }),
  );

  updateStatus(ctx);
  migrateProfiles(ctx).then(() => {
    updateStatus(ctx);
    checkSignIn(ctx);
  });
}

export function deactivate(): void {}
