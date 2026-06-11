# Deployment Guide

## How code reaches production

1. Devs work on feature branches off `dev`, PR into `dev`.
2. Admin reviews and merges `dev` → `main`.
3. Merging into `main` auto-triggers `.github/workflows/dev.yml`:
   - SSHs into the droplet (`167.172.8.238`)
   - `git pull origin main`
   - `npm install && npm run build`
   - Restarts the app: `pm2 delete supportpro || true` → `pm2 start dist/app.js --name supportpro` → `pm2 save`

No manual deploy steps needed — merging to `main` **is** the deploy.

## Watching the deploy

- GitHub repo → **Actions** tab → "Deploy Backend to DigitalOcean" → confirm the run is green.
- If it fails, check the step logs (most common causes: build/`tsc` errors, SSH key issues).

## Verifying production is up after a merge

Production base URL: `https://backend.auxhr.com`

1. **Health check** — base endpoint should return a success JSON:

   ```bash
   curl https://backend.auxhr.com/v1/
   ```

   Expected: `{"status": true, "message": "Welcome to the base endpoint", ...}`

2. **Swagger docs** — confirm the API + new routes are live:

   ```
   https://backend.auxhr.com/v1/docs
   ```

3. **Spot-check a real endpoint** relevant to your change (e.g. login):

   ```bash
   curl -X POST https://backend.auxhr.com/v1/login \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com","password":"yourpassword"}'
   ```

4. **PM2 process status** (if you have SSH access):
   ```bash
   ssh root@167.172.8.238 "pm2 status supportpro && pm2 logs supportpro --lines 50 --nostream"
   ```
   Confirm status is `online` and logs show:
   ```
   MongoDB Connected
   Connected to Postgres successfully
   App is listening on http://localhost:3003
   ```

## If something goes wrong (rollback)

```bash
ssh root@167.172.8.238
cd /home/supportpro/supportpro.backend
git log --oneline -5        # find the last good commit
git reset --hard <good-commit-sha>
npm install && npm run build
pm2 restart supportpro
```
