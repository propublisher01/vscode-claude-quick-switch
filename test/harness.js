// Test harness: loads out/extension.js with a fake `vscode` API and a temporary CLAUDE_CONFIG_DIR.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const EXTENSION = path.join(__dirname, '..', 'out', 'extension.js');
const DAY = 24 * 60 * 60 * 1000;

const origLoad = Module._load;
let currentVscode;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? currentVscode : origLoad.call(this, request, ...rest);
};

// Always use the file-based credentials, even on macOS: tests must never touch the real Keychain.
Object.defineProperty(process, 'platform', { value: 'linux' });

/** Fake account / credentials payloads. */
const account = (n, org = `org-${n}`) => ({
  accountUuid: `acc-${n}`,
  organizationUuid: org,
  emailAddress: `${n}@example.com`,
  organizationName: `${n} org`,
});
const credentials = (token, org, expiresInDays) =>
  JSON.stringify({
    claudeAiOauth: { accessToken: `at-${token}`, refreshToken: `rt-${token}`, refreshTokenExpiresAt: Date.now() + expiresInDays * DAY },
    organizationUuid: org,
  });

/**
 * Builds a fresh extension instance. `ui.answers` is a queue consumed by every UI prompt, in order:
 * - quick pick (createQuickPick): a function (items) => ({ item, button? }) or undefined to dismiss
 * - showQuickPick: a function (items) => item, or undefined
 * - input box: a string, or undefined
 * - messages: the button label to click, or undefined
 */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-quick-switch-'));
  process.env.CLAUDE_CONFIG_DIR = dir;

  const ui = { answers: [], messages: [], validationErrors: [], lastItems: undefined };
  const next = () => ui.answers.shift();
  const commands = {};
  const disposable = { dispose() {} };

  currentVscode = {
    l10n: { t: (s, ...args) => s.replace(/\{(\d+)\}/g, (_, i) => String(args[i])) },
    window: {
      state: { focused: true },
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      createQuickPick: () => {
        const handlers = {};
        const qp = {
          items: [],
          selectedItems: [],
          onDidAccept: cb => ((handlers.accept = cb), disposable),
          onDidTriggerItemButton: cb => ((handlers.button = cb), disposable),
          onDidHide: cb => ((handlers.hide = cb), disposable),
          show() {
            ui.lastItems = qp.items;
            const choose = next();
            const choice = choose && choose(qp.items);
            if (!choice) {
              return handlers.hide();
            }
            if (choice.button) {
              return handlers.button({ item: choice.item, button: choice.button });
            }
            qp.selectedItems = [choice.item];
            handlers.accept();
          },
          dispose() {},
        };
        return qp;
      },
      showQuickPick: async items => {
        ui.lastItems = items;
        const choose = next();
        return choose && choose(items);
      },
      showInputBox: async opts => {
        const value = next();
        const error = value !== undefined && opts.validateInput?.(value);
        if (error) {
          ui.validationErrors.push(error);
          return undefined;
        }
        return value;
      },
      showInformationMessage: async (message, ...buttons) => {
        ui.messages.push({ level: 'info', message, buttons });
        return buttons.length ? next() : undefined; // plain notifications don't consume an answer
      },
      showWarningMessage: async (message, ...rest) => {
        const buttons = rest.filter(b => typeof b === 'string');
        ui.messages.push({ level: 'warn', message, buttons });
        return next();
      },
      showErrorMessage: async message => (ui.messages.push({ level: 'error', message }), undefined),
      onDidChangeWindowState: () => disposable,
    },
    commands: {
      registerCommand: (id, fn) => ((commands[id] = fn), disposable),
      executeCommand: async () => {},
    },
    workspace: { getConfiguration: () => ({ get: (_key, def) => def }) },
    extensions: { getExtension: () => undefined },
    StatusBarAlignment: { Left: 1, Right: 2 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    ProgressLocation: { Notification: 15 },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class { constructor(value) { this.value = value; } },
  };

  delete require.cache[require.resolve(EXTENSION)];
  const ext = require(EXTENSION);

  const secrets = new Map();
  const state = new Map();
  const ctx = {
    subscriptions: [],
    secrets: { store: async (k, v) => void secrets.set(k, v), get: async k => secrets.get(k), delete: async k => void secrets.delete(k) },
    globalState: {
      get: (k, def) => (state.has(k) ? state.get(k) : def),
      update: async (k, v) => void (v === undefined ? state.delete(k) : state.set(k, JSON.parse(JSON.stringify(v)))),
    },
  };

  const files = {
    config: path.join(dir, '.claude.json'),
    credentials: path.join(dir, '.credentials.json'),
  };
  const signIn = (acct, creds) => {
    fs.writeFileSync(files.config, JSON.stringify({ unrelated: 'kept', oauthAccount: acct }));
    fs.writeFileSync(files.credentials, creds);
  };
  const readConfig = () => JSON.parse(fs.readFileSync(files.config, 'utf8'));
  const readCredentials = () => fs.readFileSync(files.credentials, 'utf8');
  /** Saves a profile the way 1.2.0+ does. */
  const addProfile = (name, acct, creds) => {
    secrets.set(`profile:${name}`, JSON.stringify({ credentials: creds, oauthAccount: acct }));
    const profiles = state.get('profiles') ?? [];
    profiles.push({
      name,
      email: acct.emailAddress,
      organization: acct.organizationName,
      accountUuid: acct.accountUuid,
      organizationUuid: acct.organizationUuid,
      refreshExpiresAt: JSON.parse(creds).claudeAiOauth.refreshTokenExpiresAt,
      savedAt: 0,
    });
    state.set('profiles', profiles);
  };

  const activate = async () => {
    ext.activate(ctx);
    await tick(20);
  };
  const run = async (id, ...args) => commands[`claudeQuickSwitch.${id}`](...args);
  const dispose = () => {
    ctx.subscriptions.forEach(s => s.dispose());
    fs.rmSync(dir, { recursive: true, force: true });
  };

  return { ext, ctx, ui, secrets, state, files, signIn, readConfig, readCredentials, addProfile, activate, run, dispose };
}

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Quick pick helpers. */
const pickProfile = name => items => ({ item: items.find(i => i.profile?.name === name) });
const pickButton = (name, tooltip) => items => {
  const item = items.find(i => i.profile?.name === name);
  return { item, button: item.buttons.find(b => b.tooltip === tooltip) };
};

module.exports = { setup, account, credentials, pickProfile, pickButton, tick, DAY };
