const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { setup, account, credentials, usageBody, pickProfile, tick, DAY } = require('./harness');

const A = account('a');
const B = account('b');
const C = account('c');
const HOUR = 60 * 60 * 1000;

/** Fresh extension signed in to A; `prepare(h)` runs before activation. */
function scenario(prepare, fn) {
  return async () => {
    const h = setup();
    try {
      h.signIn(A, credentials('a', A.organizationUuid, 5));
      h.addProfile('a', A, credentials('a', A.organizationUuid, 5));
      h.addProfile('b', B, credentials('b', B.organizationUuid, 5));
      prepare(h);
      await h.activate();
      await tick(20);
      await fn(h);
    } finally {
      h.dispose();
    }
  };
}

const profile = (h, name) => h.state.get('profiles').find(p => p.name === name);
const listItem = (h, name) => h.ui.lastItems.find(i => i.profile?.name === name);

test('usage of the active account is fetched and shown in the status bar and the list', scenario(
  h => (h.ui.usage = usageBody(30, 60)),
  async h => {
    const call = h.ui.fetchCalls[0];
    assert.equal(call.url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(call.headers.Authorization, 'Bearer at-a');
    assert.equal(call.headers['anthropic-beta'], 'oauth-2025-04-20');

    assert.equal(profile(h, 'a').usage.fiveHour.percent, 30);
    assert.match(h.ui.statusItem.text, /Claude: a · 60%$/, 'status bar shows the highest of the two limits');
    assert.match(h.ui.statusItem.tooltip.value, /Session \(5 h\): 30%/);
    assert.match(h.ui.statusItem.tooltip.value, /Week: 60%/);

    h.ui.answers.push(undefined);
    await h.run('switch');
    assert.match(listItem(h, 'a').detail, /5h 30% · week 60%/);
  },
));

test('the status bar turns red near the limit', scenario(
  h => (h.ui.usage = usageBody(96, 50)),
  async h => {
    assert.equal(h.ui.statusItem.backgroundColor.id, 'statusBarItem.errorBackground');
  },
));

test('inactive accounts show their last known usage with its age, and a passed reset counts as 0%', scenario(
  h => {
    h.state.get('profiles').find(p => p.name === 'b').usage = {
      fetchedAt: Date.now() - 2 * HOUR,
      fiveHour: { percent: 90, resetsAt: Date.now() - 60 * 1000 },
      sevenDay: { percent: 40, resetsAt: Date.now() + DAY },
    };
  },
  async h => {
    h.ui.answers.push(undefined);
    await h.run('switch');
    assert.match(listItem(h, 'b').detail, /5h 0% · week 40% \(2 h ago\)/);
  },
));

test('an expired access token is never sent; Claude Code\'s cached usage is used instead', scenario(
  h => {
    h.signIn(A, credentials('a', A.organizationUuid, 5, { expiresAt: Date.now() - 1000 }));
    const config = h.readConfig();
    config.cachedUsageUtilization = { fetchedAtMs: Date.now() - 1000, accountUuid: 'acc-a', utilization: usageBody(12, 34) };
    fs.writeFileSync(h.files.config, JSON.stringify(config));
    h.ui.usage = usageBody(99, 99);
  },
  async h => {
    assert.equal(h.ui.fetchCalls.length, 0);
    assert.equal(profile(h, 'a').usage.sevenDay.percent, 34);
  },
));

test('Claude Code\'s cached usage of another account is ignored', scenario(
  h => {
    const config = h.readConfig();
    config.cachedUsageUtilization = { fetchedAtMs: Date.now(), accountUuid: 'acc-b', utilization: usageBody(12, 34) };
    fs.writeFileSync(h.files.config, JSON.stringify(config));
  },
  async h => {
    assert.equal(profile(h, 'a').usage, undefined);
  },
));

test('usageRefreshMinutes = 0 never calls the service', scenario(
  h => {
    h.ui.config.usageRefreshMinutes = 0;
    h.ui.usage = usageBody(30, 60);
  },
  async h => {
    assert.equal(h.ui.fetchCalls.length, 0);
  },
));

test('near the limit, the least used account is offered, and the alert is shown once per window', scenario(
  h => {
    h.addProfile('c', C, credentials('c', C.organizationUuid, 5));
    const profiles = h.state.get('profiles');
    profiles.find(p => p.name === 'b').usage = { fetchedAt: Date.now(), fiveHour: { percent: 70 }, sevenDay: { percent: 20 } };
    profiles.find(p => p.name === 'c').usage = { fetchedAt: Date.now(), fiveHour: { percent: 10 }, sevenDay: { percent: 5 } };
    // Like the real service, each answer has slightly different reset times.
    h.ui.usage = () => usageBody(95, 50);
    h.ui.answers.push(undefined); // dismiss the first alert
  },
  async h => {
    const alerts = () => h.ui.messages.filter(m => m.level === 'warn' && /has used/.test(m.message));
    assert.equal(alerts().length, 1);
    assert.match(alerts()[0].message, /"a" has used 95% of its 5-hour session limit/);
    assert.deepEqual(alerts()[0].buttons, ['Switch to "c" (10%)']);

    await h.activate(); // fresh usage, same window: no new alert
    await tick(20);
    assert.equal(alerts().length, 1);
  },
));

test('clicking the alert switches to the suggested account', scenario(
  h => {
    h.ui.usage = usageBody(20, 92);
    h.ui.answers.push('Switch to "b"');
  },
  async h => {
    await tick(20);
    assert.equal(h.readConfig().oauthAccount.accountUuid, 'acc-b');
  },
));

test('the alert can be turned off', scenario(
  h => {
    h.ui.config.usageAlertThreshold = 0;
    h.ui.usage = usageBody(99, 99);
  },
  async h => {
    assert.ok(!h.ui.messages.some(m => /has used/.test(m.message)));
  },
));

test('the plan is shown, including the Max multiplier', scenario(
  h => {
    // A profile saved by 1.3.0: no plan yet.
    h.secrets.set(
      'profile:b',
      JSON.stringify({ credentials: credentials('b', B.organizationUuid, 5, { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }), oauthAccount: B }),
    );
  },
  async h => {
    assert.equal(profile(h, 'b').plan, 'Max 20x');
    h.ui.answers.push(undefined);
    await h.run('switch');
    assert.match(listItem(h, 'b').detail, /^Max 20x/);
  },
));
