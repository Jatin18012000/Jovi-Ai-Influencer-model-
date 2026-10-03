# Data at Rest: Retention and Backups (R-18)

## What is stored, and where

| Data | Location | Sensitivity |
|---|---|---|
| Goals, decisions, scripts, prompts, QA reports | `data/jovi.db` (`tasks`, `decisions`, `production_artifacts`) | Creative IP; may contain personal notes |
| Model inputs and outputs, tool calls | `data/jovi.db` (`agent_runs`, `model_runs`) | Full prompts and outputs |
| Audit log | `data/jovi.db` (`events`, hash-chained) | Who approved what, auth failures |
| API credential **hashes** | `data/jovi.db` (`api_credentials`) | Tokens themselves are never stored |
| Generated media, reference images | `data/media`, `data/references` | Jovi's likeness |
| Secrets (API keys, operator token) | `.env` / environment | Highest |

## Protection in place

- **Permissions** (applied every time the database is opened):
  - `data/jovi.db` and its WAL/SHM files are `0600`.
  - `data/` is `0700`: that is the default `data/` directory, or any directory Jovi creates for the database.
  - Media directories are created `0700` and media files `0600`.
- **Retention** runs daily in the worker, or on demand with `npm run jovi -- --retention [--dry-run]`:
  - `JOVI_RUN_RETENTION_DAYS` (default 180): finished `agent_runs` and `model_runs` older than this are deleted.
  - `JOVI_EVENT_RETENTION_DAYS` (default **0 = keep the audit log forever**). When set:
    - the oldest events are pruned after the hash of the last pruned event is stored as an audit checkpoint, so the remaining chain still verifies;
    - the pruning itself is recorded as a chained `RETENTION_APPLIED` event;
    - approvals whose event was pruned are reported as "not attested" by the publishing gate, so re-approve before publishing.
  - `JOVI_SUPERSEDED_RETENTION_DAYS` (default 7): files of replaced media are deleted (R-05).

## Backups

```bash
npm run jovi -- --backup ~/Backups/jovi-$(date +%F).db
```

- The backup is an online SQLite copy, consistent while Jovi is running.
- It is written owner-only (`0600`) and never overwrites an existing file.
- It contains everything in the table above except media and `.env`.
- Back up `data/media` and `data/references` separately (for example with Time Machine).
- Store backups encrypted, and test a restore: stop Jovi, copy the backup to `data/jovi.db`, start Jovi, then run `npm run jovi -- --audit-verify`.

## Disk encryption (macOS)

The database and media are plaintext files. On the Mac that runs Jovi:
- **Turn on FileVault:** System Settings → Privacy & Security → FileVault.
- **Encrypt external backup disks:** Time Machine → Options → "Encrypt backups".
- **Keep `.env` owner-only:** `chmod 600 .env`.

Do not sync `data/` or `.env` to cloud folders (iCloud Drive, Dropbox) unless they are end-to-end encrypted.
