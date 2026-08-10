# Screenshots

Cloudflare Worker that uploads screenshots to R2 and serves them from public links.

## Local

```sh
pnpm install
pnpm test
pnpm run typecheck
pnpm run deploy:dry-run
```

Set local upload authentication in `.dev.vars`:

```text
UPLOAD_TOKEN=your-local-token
```

## Deploy

Push to `main`. GitHub Actions deploys automatically.

Required GitHub secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The production `UPLOAD_TOKEN` is stored as a Cloudflare Worker secret.
