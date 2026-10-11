const { createApp } = require('../server');

// TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set in the Vercel project.
// Without them the app falls back to /tmp, which Vercel does not persist.
const application = createApp({
  dataDirectory: '/tmp'
});

module.exports = application.app;
