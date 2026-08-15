# Deploy configuration (one-time setup branch)

Detect the deploy platform, production URL, and health checks, then persist a
`## Deploy Configuration` block to CLAUDE.md so future runs skip detection.

## Detect the platform

File-presence detection:

| Marker | Platform |
|--------|----------|
| `fly.toml` | Fly.io |
| `render.yaml` | Render |
| `vercel.json` or `.vercel/` | Vercel |
| `netlify.toml` | Netlify |
| `Procfile` | Heroku |
| `railway.json` / `railway.toml` | Railway |

Also scan `.github/workflows/*.yml` for deploy workflows (grep
`deploy|release|production|staging|cd`), and infer project type: package.json
with `"bin"` → CLI; `*.gemspec` → library (these may not deploy at all).

## Platform-specific setup

- **Fly.io:** extract the app name from fly.toml; verify with
  `fly status --app {app}` if the CLI is installed; infer
  `https://{app}.fly.dev`; status command `fly status --app {app}`. Confirm the
  URL with the user — some Fly apps use custom domains.
- **Render:** extract service name/type from render.yaml; infer
  `https://{service}.onrender.com`. Render auto-deploys on push to the
  connected branch — the deploy wait should poll the URL until the new version
  responds.
- **Vercel:** auto-deploys on push — preview on PR, production on merge. Health
  check = the production URL from project settings.
- **Netlify:** auto-deploys on push; health check = the production URL from
  netlify.toml/site settings.
- **GitHub Actions only:** read the workflow to understand what it does;
  extract the deploy target; ask the user for the production URL.
- **Nothing detected:** elicit via AskUserQuestion:
  1. How are deploys triggered? (auto on push / GH Actions workflow / deploy
     script or CLI / manually / this project doesn't deploy)
  2. What's the production URL?
  3. How can a deploy's success be checked? (HTTP health check URL / CLI
     command / workflow status / just check the URL loads)
  4. Any pre-merge or post-merge hooks?

## Write the configuration

Find and replace the `## Deploy Configuration` section in CLAUDE.md (or append
it):

```markdown
## Deploy Configuration
- Platform: {platform}
- Production URL: {url}
- Deploy workflow: {workflow file or "auto-deploy on push"}
- Deploy status command: {command or "HTTP health check"}
- Merge method: {squash/merge/rebase}
- Project type: {web app / API / CLI / library}
- Post-deploy health check: {health check URL or command}

### Custom deploy hooks
- Pre-merge: {command or "none"}
- Deploy trigger: {command or "automatic on push to main"}
- Deploy status: {command or "poll production URL"}
- Health check: {URL or command}
```

Verify by curling the health check, then print the summary and stop.

## Rules

- **Never expose secrets.** Don't print full API keys, tokens, or passwords.
- **Confirm with the user** before writing — show the detected config first.
- **CLAUDE.md is the source of truth** — no separate config file.
- **Idempotent** — re-running overwrites the previous config cleanly.
