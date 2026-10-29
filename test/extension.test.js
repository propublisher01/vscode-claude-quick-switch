const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { setup, account, credentials, pickProfile, pickButton } = require('./harness');

const A = account('a');
const B = account('b');
const C = account('c');

/** Runs `fn` with a fresh extension, signed in to A, with profiles a and b saved. */
function withTwoProfiles(fn) {
  return async () => {
    const h = setup();
    try {
      h.signIn(A, credentials('a', A.organizationUuid, 5));
      h.addProfile('a', A, credentials('a', A.organizationUuid, 5));
      h.addProfile('b', B, credentials('b', B.organizationUuid, 5));
      await h.activate();
      await fn(h);
    } finally {
      h.dispose();
    }
  };
}

// --- Switching -----------------------------------------------------------------

test('switching swaps the sign-in and keeps the rest of .claude.json', withTwoProfiles(async h => {
  h.ui.answers.push(pickProfile('b'));
  await h.run('switch');
  assert.equal(h.readConfig().oauthAccount.accountUuid, 'acc-b');
  assert.equal(h.readConfig().unrelated, 'kept');
  assert.match(h.readCredentials(), /rt-b/);
}));

test('switching first saves the tokens Claude Code refreshed for the active account', withTwoProfiles(async h => {
  fs.writeFileSync(h.files.credentials, credentials('a-refreshed', A.organizationUuid, 7));
  h.ui.answers.push(pickProfile('b'));
  await h.run('switch');
  assert.match(JSON.parse(h.secrets.get('profile:a')).credentials, /rt-a-refreshed/);
}));

test('switching to an expired profile asks first', withTwoProfiles(async h => {
  h.addProfile('c', C, credentials('c', C.organizationUuid, -1));
  h.ui.answers.push(pickProfile('c'), undefined); // dismiss the warning
  await h.run('switch');
  assert.ok(h.ui.messages.some(m => m.level === 'warn' && /has expired/.test(m.message)));
  assert.equal(h.readConfig().oauthAccount.accountUuid, 'acc-a', 'not switched when dismissed');

  h.ui.answers.push(pickProfile('c'), 'Switch anyway');
  await h.run('switch');
  assert.equal(h.readConfig().oauthAccount.accountUuid, 'acc-c');
}));

// --- Account list ----------------------------------------------------------------

test('the list marks the active account and shows expiry', withTwoProfiles(async h => {
  h.addProfile('c', C, credentials('c', C.organizationUuid, -1));
  h.ui.answers.push(undefined);
  await h.run('switch');
  const item = name => h.ui.lastItems.find(i => i.profile?.name === name);
  assert.match(item('a').label, /\$\(check\)/);
  assert.match(item('b').label, /\$\(account\)/);
  assert.match(item('a').detail, /valid for 4 days/);
  assert.match(item('c').detail, /expired/);
}));

test('accounts are matched by UUID, so renaming the organization keeps the match', withTwoProfiles(async h => {
  h.signIn({ ...A, organizationName: 'Renamed org' }, credentials('a', A.organizationUuid, 5));
  h.ui.answers.push(undefined);
  await h.run('switch');
  assert.match(h.ui.lastItems.find(i => i.profile?.name === 'a').label, /\$\(check\)/);
}));

test('profiles saved before 1.2.0 get their UUIDs and expiry on activation', async () => {
  const h = setup();
  try {
    h.signIn(A, credentials('a', A.organizationUuid, 5));
    h.secrets.set('profile:a', JSON.stringify({ credentials: credentials('a', A.organizationUuid, 5), oauthAccount: A }));
    h.state.set('profiles', [{ name: 'a', email: A.emailAddress, organization: A.organizationName, savedAt: 0 }]);
    await h.activate();
    const [profile] = h.state.get('profiles');
    assert.equal(profile.accountUuid, 'acc-a');
    assert.equal(profile.organizationUuid, 'org-a');
    assert.ok(profile.refreshExpiresAt > Date.now());
  } finally {
    h.dispose();
  }
});

// --- Previous account --------------------------------------------------------------

test('"switch to previous account" toggles between the last two accounts', withTwoProfiles(async h => {
  h.addProfile('c', C, credentials('c', C.organizationUuid, 5));
  h.ui.answers.push(pickProfile('c'));
  await h.run('switch'); // a -> c
  await h.run('switchPrevious'); // c -> a
  assert.equal(h.readConfig().oauthAccount.accountUuid, 'acc-a');
  await h.run('switchPrevious'); // a -> c
  assert.equal(h.readConfig().oauthAccount.accountUuid, 'acc-c');
}));

test('"switch to previous account" without history picks the only other account', withTwoProfiles(async h => {
  await h.run('switchPrevious');
  assert.equal(h.readConfig().oauthAccount.accountUuid, 'acc-b');
}));

test('"switch to previous account" without history and several accounts opens the list', withTwoProfiles(async h => {
  h.addProfile('c', C, credentials('c', C.organizationUuid, 5));
  h.ui.answers.push(undefined);
  await h.run('switchPrevious');
  assert.ok(h.ui.lastItems.some(i => i.profile?.name === 'c'), 'list shown');
  assert.equal(h.readConfig().oauthAccount.accountUuid, 'acc-a', 'nothing switched');
}));

// --- Rename / delete -----------------------------------------------------------------

test('renaming from the list moves the profile and keeps the previous-account link', withTwoProfiles(async h => {
  h.ui.answers.push(pickProfile('b'));
  await h.run('switch'); // previous = a
  h.ui.answers.push(pickButton('a', 'Rename'), 'personal', undefined); // rename, then dismiss the reopened list
  await h.run('switch');
  assert.deepEqual(h.state.get('profiles').map(p => p.name), ['b', 'personal']);
  assert.ok(h.secrets.has('profile:personal'));
  assert.ok(!h.secrets.has('profile:a'));
  await h.run('switchPrevious');
  assert.equal(h.readConfig().oauthAccount.accountUuid, 'acc-a');
}));

test('renaming to an existing name is refused', withTwoProfiles(async h => {
  h.ui.answers.push(pickButton('a', 'Rename'), 'b');
  await h.run('switch');
  assert.match(h.ui.validationErrors[0], /already exists/);
  assert.deepEqual(h.state.get('profiles').map(p => p.name), ['a', 'b']);
}));

test('deleting from the list asks for confirmation', withTwoProfiles(async h => {
  h.ui.answers.push(pickButton('b', 'Delete'), undefined); // cancel
  await h.run('switch');
  assert.equal(h.state.get('profiles').length, 2);

  h.ui.answers.push(pickButton('b', 'Delete'), 'Delete', undefined); // confirm, then dismiss the reopened list
  await h.run('switch');
  assert.deepEqual(h.state.get('profiles').map(p => p.name), ['a']);
  assert.ok(!h.secrets.has('profile:b'));
}));

// --- Sign-in overwritten by another session ------------------------------------------------

test('tokens overwritten by another session are reported, rescued and fixable', withTwoProfiles(async h => {
  h.ui.answers.push(pickProfile('b'));
  await h.run('switch');
  // A session still on account a refreshes and writes its own tokens.
  fs.writeFileSync(h.files.credentials, credentials('a-other-session', A.organizationUuid, 7));
  h.ui.answers.push('Use "a"');
  await h.activate(); // runs the consistency check

  const warning = h.ui.messages.find(m => m.level === 'warn' && /overwritten/.test(m.message));
  assert.ok(warning, 'reported');
  assert.match(warning.message, /signed in to "a"/);
  assert.deepEqual(warning.buttons, ['Use "b"', 'Use "a"']);
  assert.match(JSON.parse(h.secrets.get('profile:a')).credentials, /rt-a-other-session/, 'fresh tokens rescued');
  assert.equal(h.readConfig().oauthAccount.accountUuid, 'acc-a', '.claude.json matches the tokens again');
}));

test('saving is refused while the sign-in is inconsistent', withTwoProfiles(async h => {
  h.signIn(B, credentials('a-other-session', A.organizationUuid, 7));
  h.ui.answers.push('b');
  await h.run('saveCurrent');
  assert.ok(h.ui.messages.some(m => m.level === 'error' && /inconsistent/.test(m.message)));
  assert.doesNotMatch(JSON.parse(h.secrets.get('profile:b')).credentials, /a-other-session/);
}));
