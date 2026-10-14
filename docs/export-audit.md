# Public export audit

The initial public release uses fresh Git history. Only application source, synthetic tests, dependency manifests, generic setup scripts, examples, CI, and documentation were selected for export.

The export excludes original Git history, deployment configuration, runtime data, authentication files, workspace instructions, saved memories and skills, transcripts, incident integrations, machine-specific scripts, and private account identifiers. Test fixtures use synthetic IDs and example domains.

Publication checks include:

- TypeScript checks for application and setup scripts, automated tests, and a production build.
- Dependency installation using a fresh package store.
- Offline supervisor startup with a fake App Server and temporary state, without platform connections.
- Comparison against locally known credential values, reporting filenames only.
- Gitleaks scans of the exported files and fresh Git history.
- `pnpm audit:export` for private paths and common credential formats in tracked files and reachable history.

No live Discord or WhatsApp delivery is part of the public-release test. Pairing, permissions, and account-specific model availability must be checked by the operator. Scanners cannot prove that arbitrary prose contains no sensitive information; manual review remains part of publication.

## October source review

The update selects generic runtime, transport, model-command, progress, and worktree fixes. It preserves standalone configuration validation, configurable agent instructions, and sandbox settings. Tests use synthetic identities and temporary state. No private source history, saved skill or memory contents, operator configuration, incident automation, remote-host setup, or organization-specific deployment tooling is part of this update.

Runtime behavior now follows the latest validated revision between turns. Original bindings remain historical records, and execution snapshots record each selected revision. Active turns and steering retain their engine until completion. Final notifications reply to the original initiating prompt; subsequent steering inputs update the activity panel.

Latency records contain stage labels, counters, and model/effort settings. The local reporting tool filters by the caller's workspace and defaults to its own task. Raw stderr is classified into diagnostic labels and discarded.
