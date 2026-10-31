# Untrace

Untrace is a local-first desktop app for bulk-deleting your own content across
social networks and messengers. Credentials and backups stay on your device, and
every run shows a dry-run preview, keeps an encrypted backup and ends with a signed
receipt. The deletion engine lives in [Lethe](https://github.com/ForeverInLaw/lethe).

The project is in early alpha. The Bluesky path is wired end to end, Telegram is
wired behind feature flags but has not yet run against a real account, and the
other services shown in the app are not implemented.

## Building

Clone both repos side by side, because Untrace uses path dependencies on `../lethe`.
On Linux you also need the [Tauri system dependencies](https://tauri.app/start/prerequisites/).

```
git clone https://github.com/ForeverInLaw/lethe
git clone https://github.com/ForeverInLaw/untrace
cd untrace
npm ci
npm run build
cargo test --workspace
```

External contributions are not accepted yet: a CLA comes first.

License: AGPL-3.0-only.
