# Internship Tracker - Docker & Jenkins CI/CD Demo

## Aim
To build a simple Internship Tracker web application and automate its testing, containerization, and deployment using Git, GitHub, Docker, and Jenkins.

## Objectives
- Build a small Node.js/Express application with a REST API and a simple frontend.
- Write automated tests using the built-in Node.js test runner.
- Package the application as a Docker image.
- Create a Jenkins declarative pipeline: Checkout, Install, Test, Build, Deploy, Verify.
- Store the source code in GitHub and run the pipeline from it.

## Software Requirements
| Software | Purpose |
|---|---|
| Node.js 18+ and npm | Run the app and tests |
| Git | Version control |
| GitHub account | Remote repository |
| Docker (Desktop on Windows, Engine on Linux) | Build and run the container |
| Jenkins (Linux agent) with Git, Node.js/npm, Docker CLI, curl | CI/CD |

## Architecture
```
Browser --> Express server (server.js) --> SQLite database
               |                          |-- salted password hashes
               |                          |-- per-user applications
               |                          `-- persistent sessions
          Sign up / Login

GitHub --> Jenkins --> npm test --> docker build --> docker run (port 3000) --> curl /api/health
```

## Accounts and security
- Users can create their own account from the sign-in page. Usernames are case-insensitive, 3-32 characters, and passwords must be at least 10 characters.
- Passwords are stored as salted scrypt hashes; plaintext passwords are never persisted.
- Application records are isolated by account and stored in SQLite under `data/` by default.
- Sessions are stored in SQLite and use HTTP-only, same-site cookies. Production requires a `SESSION_SECRET` of at least 32 characters. When HTTPS terminates at one trusted reverse proxy, set `COOKIE_SECURE=true` and `TRUST_PROXY=true`.
- Authentication attempts are rate-limited. Health checks are public; application APIs require a valid session.
- Back up the SQLite database file in `data/` if you need to preserve user data.

## Implementation Procedure
1. Create the project files listed in the folder structure.
2. Set a session secret for production and run `npm ci` and `npm start`.
3. Open http://localhost:3000 and create an account.
4. Run `npm test` to verify authentication, account isolation, and application APIs.
5. Build and run the Docker image.
6. Push the project to GitHub.
7. Create a Jenkins Pipeline job that uses the Jenkinsfile from GitHub.
8. Run the pipeline and verify the deployed app.

## Commands

### Local run and tests (PowerShell)
```
npm install
npm test
$env:SESSION_SECRET = 'replace-with-a-long-random-secret'
npm start
```

### Docker
```
docker build -t internship-tracker .
docker run -d --name internship-tracker -p 3000:3000 -e SESSION_SECRET=replace-with-a-long-random-secret -v internship-tracker-data:/app/data internship-tracker
docker ps
docker logs internship-tracker
docker stop internship-tracker
docker rm internship-tracker
```

Check the app at http://localhost:3000 (sign-in page; health check: http://localhost:3000/api/health). The named Docker volume preserves SQLite data across container replacements.

### GitHub
```
git init
git add .
git commit -m "Initial commit: Internship Tracker"
git branch -M main
git remote add origin https://github.com/<your-username>/internship-tracker.git
git push -u origin main
```

## Vercel Deployment
Vercel functions have no persistent disk, so the Vercel deployment stores data in a hosted [Turso](https://turso.tech) database.

1. Create a Turso database (Vercel dashboard -> Storage -> Turso, or at turso.tech) and note its URL (`libsql://...`) and an auth token.
2. Import the GitHub repository in Vercel (or run `vercel link`).
3. Add these environment variables for Production:

| Variable | Value |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://<your-db>.turso.io` |
| `TURSO_AUTH_TOKEN` | Turso database token |
| `SESSION_SECRET` | Random string of at least 32 characters |
| `NODE_ENV` | `production` |
| `COOKIE_SECURE` | `true` |
| `TRUST_PROXY` | `true` |

4. Deploy (`vercel --prod` or push to `main`). Tables are created automatically on first request.

`vercel.json` sends every request to `api/index.js`, which wraps the Express app.

## Jenkins Pipeline Procedure
1. Make sure the Jenkins agent has Git, Node.js/npm, Docker CLI and curl, and that the `jenkins` user can access the Docker daemon (`sudo usermod -aG docker jenkins`, then restart Jenkins). In Jenkins credentials, add a **Secret text** credential with ID `internship-tracker-session-secret` and a long random value.
2. Jenkins dashboard -> New Item -> name `internship-tracker-pipeline` -> Pipeline -> OK.
3. Under Pipeline: Definition = **Pipeline script from SCM**, SCM = **Git**.
4. Repository URL = your GitHub URL. Branch = `*/main`. Script Path = `Jenkinsfile`.
5. Save, then click **Build Now**.
6. Open the build's **Console Output** to follow each stage.

Port 3000 must be free on the machine running the deployed container, and the Jenkins agent must be able to reach it at `http://localhost:3000`. The pipeline retrieves `SESSION_SECRET` from the Jenkins credential above and mounts the persistent `internship-tracker-data` volume at `/app/data`. Do not expose the app to the public internet over plain HTTP; terminate HTTPS at a trusted reverse proxy and set `COOKIE_SECURE=true`.

## Expected Output
- `npm test`: authentication, user isolation, and application API tests pass.
- Jenkins: all six stages are green and the console ends with "Health check passed".
- http://localhost:3000 shows the sign-in / account creation page.
- `/api/health` returns `{"status":"ok"}`.

## Result and Conclusion
The Internship Tracker was built, tested, containerized with Docker, and deployed automatically through a Jenkins pipeline using a GitHub repository. This demonstrates a basic CI/CD workflow in which every change is tested, built into an image, deployed, and health-checked automatically.

## Suggested Screenshots
1. Project folder structure in the editor
2. `npm test` output with passing tests
3. App running at http://localhost:3000 with a few applications added
4. `docker build` and `docker ps` output
5. GitHub repository page
6. Jenkins job configuration (Pipeline script from SCM)
7. Jenkins Stage View with all stages green
8. Jenkins Console Output ending with "Health check passed"
9. `/api/health` response in the browser
