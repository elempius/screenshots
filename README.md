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

Uploads authenticate with an `Authorization: Bearer <token>` header, keeping
the token out of URLs and access logs.

Only image uploads are accepted (`png`, `jpeg`, `webp`, `gif`, `heic`, `heif`,
`tiff`, `bmp`, `avif`); other content types are rejected with `415`.

## Deploy

Push to `main`. GitHub Actions deploys automatically.

Required GitHub secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The production `UPLOAD_TOKEN` is stored as a Cloudflare Worker secret.

## Cost

Typical small usage fits within Cloudflare free allowances:

- Workers: 100,000 requests per day on the Free plan.
- R2 Standard: 10 GB-month of storage, 1 million Class A operations, and 10 million Class B operations per month.
- R2 egress: free.

This Worker uses R2 Class A operations for uploads and Class B operations for reads. Cached responses still count as Worker requests, but reduce R2 reads and Worker CPU usage.

The Workers Paid plan starts at $5 USD per month and includes 10 million requests and 30 million CPU milliseconds per month. R2 usage beyond its free allowance is billed separately.

Prices can change. See [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [R2 pricing](https://developers.cloudflare.com/r2/pricing/).
