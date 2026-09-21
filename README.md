# DeployDiff — full-stack MVP

## Run

1. Install Node.js 18 or later.
2. In this folder, run `npm start`.
3. Open `http://localhost:3000`.

No third-party packages are required.

## User flow

1. Upload the application artifact (optional in the MVP), the previous known-good config, and the current deployment config—or paste the configs.
2. Review added, removed, changed, and critical configuration entries.
3. Edit the candidate config in the right-side editor, re-run analysis, and download the reviewed config.

The Node backend accepts config text as `.env`, JSON, or basic YAML `key: value` content; it locally stores the uploaded application artifact and a compact snapshot history under `data/`. Secret-looking fields are masked in reports, but the raw config is retained locally to enable editing—do not run this on a shared or untrusted machine with production secrets.

## Production work still needed

Add encrypted secret storage or external secret references, real YAML/Helm/Kubernetes parsers, authentication/roles, CI/CD webhooks, policy configuration, audit logging, malware scanning of artifacts, and a database/object store.
