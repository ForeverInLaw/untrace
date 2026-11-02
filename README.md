# Untrace

Untrace is a local-first desktop app for bulk-deleting your own content across
social networks and messengers. Credentials and backups stay on your device, and
every run shows a dry-run preview, keeps an encrypted backup and ends with a signed
receipt. The deletion engine lives in [Lethe](https://github.com/ForeverInLaw/lethe).

The project is in early alpha. The Bluesky path works end to end and has passed a live
cleanup, with a post's text and files in the backup. Telegram works behind feature flags and has passed live runs on a test group, with
media files in the backup. Each item also goes in whole, as the platform returned it, so
polls, contacts, alt text and links are kept. An item the platform does not fully hand
over is deleted only after a separate confirmation. A backup can be exported into a plain, unencrypted folder of text and files, including the backup of a run that was stopped or crashed. An item whose file could not be saved stays on the platform and is listed on the receipt, where it can be tried again, or deleted without the file after a separate confirmation if the platform refuses to hand the file over. The app lists only the services that work in the current build, in Russian
or English.

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
