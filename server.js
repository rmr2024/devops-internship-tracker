const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { createClient } = require('@libsql/client');
const session = require('express-session');

const VALID_STATUSES = ['Applied', 'Interview', 'Offer'];
const PASSWORD_KEY_LENGTH = 64;
const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Applied',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS applications_by_user
    ON applications(user_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    session_data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expires_at)'
];

class SqlSessionStore extends session.Store {
  constructor(query) {
    super();
    this.query = query;
  }

  get(sessionId, callback) {
    this.query(
      'SELECT session_data FROM sessions WHERE session_id = ? AND expires_at > ?',
      [sessionId, Date.now()]
    )
      .then((result) => {
        const row = result.rows[0];
        callback(null, row ? JSON.parse(row.session_data) : null);
      })
      .catch(callback);
  }

  set(sessionId, sessionData, callback = () => {}) {
    this.query(`
      INSERT INTO sessions (session_id, session_data, expires_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        session_data = excluded.session_data,
        expires_at = excluded.expires_at
    `, [sessionId, JSON.stringify(sessionData), sessionExpiry(sessionData)])
      .then(() => callback(null))
      .catch(callback);
  }

  touch(sessionId, sessionData, callback = () => {}) {
    this.query(
      'UPDATE sessions SET expires_at = ? WHERE session_id = ?',
      [sessionExpiry(sessionData), sessionId]
    )
      .then(() => callback(null))
      .catch(callback);
  }

  destroy(sessionId, callback = () => {}) {
    this.query('DELETE FROM sessions WHERE session_id = ?', [sessionId])
      .then(() => callback(null))
      .catch(callback);
  }

  clearExpiredSessions() {
    return this.query('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]);
  }
}

function sessionExpiry(sessionData) {
  return sessionData.cookie?.expires
    ? new Date(sessionData.cookie.expires).getTime()
    : Date.now() + 8 * 60 * 60 * 1000;
}

// Uses a remote Turso database when TURSO_DATABASE_URL is set, otherwise a local SQLite file.
function openDatabase(options) {
  const remoteUrl = options.databaseUrl || process.env.TURSO_DATABASE_URL;
  if (remoteUrl) {
    return {
      local: false,
      client: createClient({
        url: remoteUrl,
        authToken: options.databaseAuthToken || process.env.TURSO_AUTH_TOKEN
      })
    };
  }

  const dataDirectory = options.dataDirectory || process.env.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(dataDirectory, { recursive: true });
  const databasePath = options.databasePath || path.join(dataDirectory, 'internship-tracker.sqlite');
  return {
    local: true,
    client: createClient({ url: pathToFileURL(databasePath).href })
  };
}

async function initializeDatabase(database, local) {
  if (local) {
    await database.execute('PRAGMA journal_mode = WAL');
  }
  await database.execute('PRAGMA foreign_keys = ON');
  await database.batch(SCHEMA, 'write');
}

// Express 4 does not forward rejected promises to the error handler.
const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

function createApp(options = {}) {
  const sessionSecret = options.sessionSecret || process.env.SESSION_SECRET;
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction && (!sessionSecret || sessionSecret.length < 32)) {
    throw new Error('SESSION_SECRET must contain at least 32 characters when NODE_ENV=production');
  }
  if (!sessionSecret) {
    console.warn('SESSION_SECRET is unset; sessions will be invalidated when the server restarts.');
  }

  const { client: database, local } = openDatabase(options);
  const withRetry = (operation) => operation().catch((error) => {
    if (!isDroppedConnection(error)) throw error;
    return operation();
  });

  // A failed initialization is retried on the next request instead of being cached.
  let initialization = null;
  const ensureReady = () => {
    if (!initialization) {
      initialization = withRetry(() => initializeDatabase(database, local)).catch((error) => {
        initialization = null;
        console.error('Database initialization failed:', error);
        throw error;
      });
    }
    return initialization;
  };

  const query = async (sql, args = []) => {
    await ensureReady();
    return withRetry(() => database.execute({ sql, args }));
  };

  const app = express();
  const publicDirectory = path.join(__dirname, 'public');

  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
  }
  app.use(express.json({ limit: '10kb' }));
  const sessionStore = new SqlSessionStore(query);
  app.use(session({
    name: 'internship.sid',
    secret: sessionSecret || crypto.randomBytes(48).toString('hex'),
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.COOKIE_SECURE === 'true',
      maxAge: 30 * 24 * 60 * 60 * 1000
    }
  }));

  app.get('/api/health', async (req, res) => {
    try {
      await query('SELECT 1');
      res.status(200).json({ status: 'ok' });
    } catch (error) {
      console.error('Health check failed:', error);
      res.status(503).json({ status: 'error' });
    }
  });

  app.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect('/');
    res.sendFile(path.join(publicDirectory, 'login.html'));
  });

  app.get('/login.html', (req, res) => res.redirect('/login'));
  app.get('/index.html', (req, res) => res.redirect('/'));

  app.get('/', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(publicDirectory, 'index.html'));
  });

  app.get('/api/auth/me', asyncHandler(async (req, res) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const user = (await query('SELECT id, username FROM users WHERE id = ?', [req.session.userId])).rows[0];
    if (!user) {
      return req.session.destroy(() => {
        res.clearCookie('internship.sid');
        res.status(401).json({ error: 'Authentication required' });
      });
    }
    res.status(200).json({ user: { id: user.id, username: user.username } });
  }));

  app.post('/api/auth/register', asyncHandler(async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!USERNAME_PATTERN.test(username)) {
      return res.status(400).json({
        error: 'Username must be 3–32 characters using letters, numbers, dots, hyphens, or underscores.'
      });
    }
    if (password.length < 10 || password.length > 128) {
      return res.status(400).json({ error: 'Password must be between 10 and 128 characters.' });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = await hashPassword(password, salt);
    const user = { id: crypto.randomUUID(), username };

    try {
      await query(`
        INSERT INTO users (id, username, password_salt, password_hash)
        VALUES (?, ?, ?, ?)
      `, [user.id, user.username, salt, passwordHash.toString('hex')]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return res.status(409).json({ error: 'That username is already taken.' });
      }
      throw error;
    }

    await regenerateSession(req);
    req.session.userId = user.id;
    await saveSession(req);
    res.status(201).json({ user });
  }));

  app.post('/api/auth/login', asyncHandler(async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const userRecord = (await query(`
      SELECT id, username, password_salt, password_hash
      FROM users WHERE username = ? COLLATE NOCASE
    `, [username])).rows[0];

    const salt = userRecord?.password_salt || 'invalid-user-login-salt';
    const candidate = await hashPassword(password, salt);
    const expected = userRecord
      ? Buffer.from(userRecord.password_hash, 'hex')
      : Buffer.alloc(PASSWORD_KEY_LENGTH);
    const valid = candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);

    if (!userRecord || !valid) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    await regenerateSession(req);
    req.session.userId = userRecord.id;
    await saveSession(req);
    res.status(200).json({
      user: { id: userRecord.id, username: userRecord.username }
    });
  }));

  app.post('/api/auth/logout', (req, res, next) => {
    if (!req.session.userId) {
      res.clearCookie('internship.sid', { sameSite: 'strict' });
      return res.status(204).send();
    }
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie('internship.sid', { sameSite: 'strict' });
      res.status(204).send();
    });
  });

  app.use('/api/applications', (req, res, next) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    next();
  });

  app.get('/api/applications', asyncHandler(async (req, res) => {
    const result = await query(`
      SELECT id, company, role, status
      FROM applications WHERE user_id = ?
      ORDER BY created_at DESC, rowid DESC
    `, [req.session.userId]);
    res.status(200).json(result.rows.map(toApplication));
  }));

  app.post('/api/applications', asyncHandler(async (req, res) => {
    const company = typeof req.body?.company === 'string' ? req.body.company.trim() : '';
    const role = typeof req.body?.role === 'string' ? req.body.role.trim() : '';

    if (!company || !role) {
      return res.status(400).json({ error: 'company and role are required' });
    }
    if (company.length > 120 || role.length > 120) {
      return res.status(400).json({ error: 'company and role must be 120 characters or fewer' });
    }

    const application = {
      id: crypto.randomUUID(),
      company,
      role,
      status: 'Applied'
    };
    await query(`
      INSERT INTO applications (id, user_id, company, role, status)
      VALUES (?, ?, ?, ?, ?)
    `, [application.id, req.session.userId, company, role, application.status]);
    res.status(201).json(application);
  }));

  app.put('/api/applications/:id', asyncHandler(async (req, res) => {
    const status = req.body?.status;
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        error: 'status must be one of: ' + VALID_STATUSES.join(', ')
      });
    }

    const result = await query(`
      UPDATE applications SET status = ?
      WHERE id = ? AND user_id = ?
      RETURNING id, company, role, status
    `, [status, req.params.id, req.session.userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }
    res.status(200).json(toApplication(result.rows[0]));
  }));

  app.delete('/api/applications/:id', asyncHandler(async (req, res) => {
    const result = await query(`
      DELETE FROM applications WHERE id = ? AND user_id = ?
    `, [req.params.id, req.session.userId]);
    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }
    res.status(204).send();
  }));

  app.use(express.static(publicDirectory, { index: false }));

  app.use((error, req, res, next) => {
    if (error instanceof SyntaxError && 'body' in error) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    console.error('Request failed:', error);
    if (res.headersSent) return next(error);
    res.status(500).json({ error: 'Server error' });
  });

  const cleanupTimer = setInterval(() => {
    sessionStore.clearExpiredSessions()
      .catch((error) => console.error('Session cleanup failed:', error));
  }, 60 * 60 * 1000);
  cleanupTimer.unref();

  return {
    app,
    ready: ensureReady,
    close() {
      clearInterval(cleanupTimer);
      database.close();
    }
  };
}

function toApplication(row) {
  return { id: row.id, company: row.company, role: row.role, status: row.status };
}

// Serverless instances can resume with keep-alive sockets the database has already closed.
function isDroppedConnection(error) {
  const code = error.cause?.code || error.code;
  return ['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'UND_ERR_CLOSED'].includes(code) ||
    /fetch failed|other side closed/i.test(error.message);
}

function isUniqueViolation(error) {
  const codes = [error.code, error.extendedCode, error.cause?.code, error.cause?.extendedCode];
  return codes.includes('SQLITE_CONSTRAINT_UNIQUE') ||
    (codes.includes('SQLITE_CONSTRAINT') && /UNIQUE/i.test(error.message));
}

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, PASSWORD_KEY_LENGTH, (error, key) => {
      if (error) return reject(error);
      resolve(key);
    });
  });
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => error ? reject(error) : resolve());
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => error ? reject(error) : resolve());
  });
}

if (require.main === module) {
  let application;

  try {
    application = createApp();
  } catch (error) {
    console.error('Unable to start Internship Tracker:', error.message);
    process.exitCode = 1;
  }

  if (application) {
    const PORT = process.env.PORT || 3000;

    const server = application.app.listen(PORT, () => {
      console.log(`Internship Tracker running on port ${PORT}`);
    });

    const shutdown = () => {
      server.close(() => {
        application.close();
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

module.exports = { createApp };
