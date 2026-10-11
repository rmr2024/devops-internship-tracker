const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');

let server;
let baseUrl;
let application;
let dataDirectory;
let agentOne;
let agentTwo;

function cookieAgent() {
  let cookie = '';
  return {
    async fetch(url, options = {}) {
      const headers = new Headers(options.headers);
      if (cookie) headers.set('Cookie', cookie);
      const response = await fetch(url, { ...options, headers, redirect: 'manual' });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return response;
    }
  };
}

before(async () => {
  dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'internship-tracker-test-'));
  application = createApp({
    dataDirectory,
    sessionSecret: 'test-only-session-secret-with-enough-entropy'
  });
  await new Promise((resolve) => {
    server = application.app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  agentOne = cookieAgent();
  agentTwo = cookieAgent();
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  application.close();
  try {
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  } catch (error) {
    // Windows keeps the SQLite file locked until the libSQL handle is garbage collected.
    if (error.code !== 'EPERM') throw error;
  }
});

test('GET /api/health returns status ok', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body, { status: 'ok' });
});

test('unauthenticated users are sent to the sign-in page', async () => {
  const dashboard = await fetch(`${baseUrl}/`, { redirect: 'manual' });
  assert.strictEqual(dashboard.status, 302);
  assert.strictEqual(dashboard.headers.get('location'), '/login');

  const login = await fetch(`${baseUrl}/login`);
  assert.strictEqual(login.status, 200);
  assert.match(await login.text(), /Create account/);
});

test('application data requires an authenticated session', async () => {
  const res = await fetch(`${baseUrl}/api/applications`);
  assert.strictEqual(res.status, 401);
  assert.deepStrictEqual(await res.json(), { error: 'Authentication required' });
});

test('users can register, sign in, and keep application data private', async () => {
  const register = await agentOne.fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'First.User', password: 'correct horse battery' })
  });
  assert.strictEqual(register.status, 201);
  const signedUp = await register.json();
  assert.strictEqual(signedUp.user.username, 'First.User');
  assert.ok(!JSON.stringify(signedUp).includes('password'));

  const duplicate = await agentTwo.fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'first.user', password: 'another secure pass' })
  });
  assert.strictEqual(duplicate.status, 409);

  const unauthenticatedMe = await fetch(`${baseUrl}/api/auth/me`);
  assert.strictEqual(unauthenticatedMe.status, 401);

  const res = await agentOne.fetch(`${baseUrl}/api/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company: 'Acme Corp', role: 'DevOps Intern' })
  });
  assert.strictEqual(res.status, 201);
  const body = await res.json();
  assert.ok(body.id);
  assert.strictEqual(body.company, 'Acme Corp');
  assert.strictEqual(body.role, 'DevOps Intern');
  assert.strictEqual(body.status, 'Applied');

  const updated = await agentOne.fetch(`${baseUrl}/api/applications/${body.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Interview' })
  });
  assert.strictEqual(updated.status, 200);
  assert.strictEqual((await updated.json()).status, 'Interview');

  const ownList = await agentOne.fetch(`${baseUrl}/api/applications`);
  assert.strictEqual(ownList.status, 200);
  assert.strictEqual((await ownList.json()).length, 1);

  const otherList = await agentTwo.fetch(`${baseUrl}/api/applications`);
  assert.strictEqual(otherList.status, 401);

  const login = await agentTwo.fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'first.USER', password: 'correct horse battery' })
  });
  assert.strictEqual(login.status, 200);

  const listAfterLogin = await agentTwo.fetch(`${baseUrl}/api/applications`);
  assert.strictEqual((await listAfterLogin.json()).length, 1);

  const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'First.User', password: 'incorrect password' })
  });
  assert.strictEqual(badLogin.status, 401);
});

test('repeated login attempts are not blocked and the user session stays active', async () => {
  const agent = cookieAgent();
  const register = await agent.fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'remember-me-user', password: 'a-long-enough-password' })
  });
  assert.strictEqual(register.status, 201);

  for (let i = 0; i < 12; i++) {
    const invalid = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'remember-me-user', password: 'wrong-password' })
    });
    assert.strictEqual(invalid.status, 401);
  }

  const valid = await agent.fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'remember-me-user', password: 'a-long-enough-password' })
  });
  assert.strictEqual(valid.status, 200);

  const applications = await agent.fetch(`${baseUrl}/api/applications`);
  assert.strictEqual(applications.status, 200);
});

test('registration validates username and password requirements', async () => {
  const shortPassword = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'validuser', password: 'short' })
  });
  assert.strictEqual(shortPassword.status, 400);

  const invalidUsername = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'no spaces allowed', password: 'long enough password' })
  });
  assert.strictEqual(invalidUsername.status, 400);
});

test('application endpoints validate input and only affect the owner', async () => {
  const createRes = await agentOne.fetch(`${baseUrl}/api/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company: 'Delete Me Ltd' })
  });
  assert.strictEqual(createRes.status, 400);

  const createdRes = await agentOne.fetch(`${baseUrl}/api/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company: 'Delete Me Ltd', role: 'Tester' })
  });
  const created = await createdRes.json();

  const invalidStatus = await agentOne.fetch(`${baseUrl}/api/applications/${created.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Hired' })
  });
  assert.strictEqual(invalidStatus.status, 400);

  const anotherUser = cookieAgent();
  const register = await anotherUser.fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'other-user', password: 'another secure password' })
  });
  assert.strictEqual(register.status, 201);

  const forbiddenDelete = await anotherUser.fetch(`${baseUrl}/api/applications/${created.id}`, {
    method: 'DELETE'
  });
  assert.strictEqual(forbiddenDelete.status, 404);

  const delRes = await agentOne.fetch(`${baseUrl}/api/applications/${created.id}`, {
    method: 'DELETE'
  });
  assert.strictEqual(delRes.status, 204);

  const listRes = await agentOne.fetch(`${baseUrl}/api/applications`);
  const list = await listRes.json();
  assert.ok(!list.some((a) => a.id === created.id));
});

test('logout invalidates the session', async () => {
  const res = await agentOne.fetch(`${baseUrl}/api/auth/logout`, { method: 'POST' });
  assert.strictEqual(res.status, 204);
  const applications = await agentOne.fetch(`${baseUrl}/api/applications`);
  assert.strictEqual(applications.status, 401);
});

test('accounts and applications survive reopening the SQLite database', async () => {
  const reopened = createApp({
    dataDirectory,
    sessionSecret: 'test-only-session-secret-with-enough-entropy'
  });
  const reopenedServer = reopened.app.listen(0, '127.0.0.1');

  try {
    await new Promise((resolve) => reopenedServer.once('listening', resolve));
    const reopenedUrl = `http://127.0.0.1:${reopenedServer.address().port}`;
    const agent = cookieAgent();
    const login = await agent.fetch(`${reopenedUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'first.user', password: 'correct horse battery' })
    });
    assert.strictEqual(login.status, 200);

    const applications = await agent.fetch(`${reopenedUrl}/api/applications`);
    const list = await applications.json();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].company, 'Acme Corp');
    assert.strictEqual(list[0].status, 'Interview');
  } finally {
    await new Promise((resolve) => reopenedServer.close(resolve));
    reopened.close();
  }
});
