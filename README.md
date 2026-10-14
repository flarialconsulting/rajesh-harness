# Rajesh Harness

Run Codex tasks from Discord or a WhatsApp group on your own machine. Each conversation keeps its Codex thread, queued input, delivery state, and source revision across restarts.

The agent can also edit and publish changes to its own harness through a validated, versioned workflow. Active turns finish on their current code. Existing conversations adopt validated patches between turns without losing their history.

The runtime uses the [Codex App Server](https://learn.chatgpt.com/docs/app-server) over stdio. It does not include Codex, an OpenAI account, or credentials.

## What it does

- Starts a Discord thread for each task, or uses a configured channel as one conversation.
- Accepts WhatsApp mentions and replies in one configured group. `/new` starts another conversation.
- Steers running tasks with follow-up messages. `/stop` cancels queued input and stops the task process.
- Stores messages, jobs, schedules, and delivery receipts in SQLite; archives older transcripts as compressed JSONL.
- Provides MCP tools for message search, explicit memory, reusable skills, Git worktrees, schedules, and file delivery.
- Runs turns on validated source snapshots and applies updates between turns.
- Sends final replies against the original prompt, with durable delivery receipts.
- Reports workspace-scoped queue, startup, response, tool, and delivery timings without storing prompts in timing records.

This public edition has no organization-specific incident automation, private workspace instructions, voice-note shortcuts, account-usage dashboards, deployment credentials, or imported conversation history.

## Self-editing between turns

You can ask Rajesh to change the harness itself from chat: add a tool, fix an adapter, or change how tasks behave. The agent has dedicated MCP tools to prepare and publish those changes.

1. `prepare_self_edit` creates an editable draft of the latest validated source and configuration, owned by the requesting task.
2. The agent edits that draft. Saved runtime revisions and conversation bindings stay untouched.
3. `publish_self_edit` installs the locked dependencies, runs TypeScript checks and tests, checks runtime exports, and probes Codex compatibility. It rejects stale drafts and configuration changes that require a restart.
4. After validation, publication records a Git commit and selects the new source snapshot. Active turns retain their code and resolved Codex executable until completion. The next turn in an existing conversation uses the latest validated snapshot, including after a service restart. Its original binding stays unchanged as history; execution snapshots record the revision used for subsequent turns.

For example, a running task finishes on its current engine when a patch is published. Its next turn resumes the same Codex conversation with the patched engine. Adapters and slash commands use the latest validated revision immediately.

`runtime_status` exposes the original conversation binding, current execution snapshot, latest published revision, validation failures, and bootstrap changes that require a restart. Failed validation keeps the last accepted revision selected. Source hashes detect modifications to saved snapshots, and stale-draft checks prevent one task from overwriting a newer publication.

This update path covers task runtime behavior. Connection setup and supervisor/bootstrap changes still require a controlled restart. Runtime snapshots contain private operator configuration and stay local; the generated source Git commits exclude `config.json`.

## Requirements

Use Linux, Node.js 22.13 or newer, pnpm 10, Git, ripgrep, and an authenticated Codex CLI with the App Server protocol. Linux is the tested target; process groups and Unix sockets are part of the runtime. Dependencies are pinned in `pnpm-lock.yaml`.

Run the service as a dedicated OS user. Only allow trusted people into enabled channels and groups: their messages can start an agent with that user's filesystem and tool access. Workspace routing separates conversation context; it is not an OS security boundary. See [SECURITY.md](SECURITY.md).

## Set up Discord

```sh
git clone https://github.com/flarialmc/rajesh-harness.git
cd rajesh-harness
pnpm install --frozen-lockfile --ignore-scripts
pnpm setup --codex /absolute/path/to/codex --model YOUR_MODEL_ID --effort medium
```

Use a model ID available to your Codex account. Authenticate the CLI separately, using the same `codexHome` as this service. The setup command refuses to overwrite existing configuration.

1. Edit the generated `config.json`. Replace the Discord guild and channel placeholders. Set the workspace path to the directory containing your projects.
2. Create a Discord bot, enable its Message Content intent, and invite it to your server. Give it permission to view the enabled channel, read history, send messages, attach files, create public threads, and send messages in threads.
3. Put its token under `discord.main` in `.local/secrets/credentials.json`. See [the credential example](examples/credentials.example.json). Keep credentials out of `config.json`.
4. Run the checks and start the service:

```sh
pnpm doctor
pnpm check
pnpm test
pnpm start
```

`doctor` checks configuration, Codex authentication, protocol methods, and configured model/effort combinations. It does not start an agent turn or post a chat message. It cannot verify Discord permissions while offline.

Mention the bot in the configured channel. It starts a task thread; replies in that thread continue the same conversation. `/models` lists available models, `/model MODEL EFFORT` changes the next turn, `/status` shows task counts and the selected model, and `/compact` compacts an idle conversation. In a Discord task thread, `/ultrafast` enables the tier for the next turn only when the selected model advertises support; `/ultrafast enabled:false` disables it. Plain text `/ultrafast on` and `/ultrafast off` also work. Model and reasoning settings stay unchanged.

Run from the repository root. The supervisor snapshots the root `config.json`; use that file for the service. `RAJESH_CONFIG` is also used internally to select pinned configuration for child tools. Do not point the supervisor at a different configuration file.

## Configuration

[config.example.json](examples/config.example.json) lists a complete Discord configuration. All filesystem paths must be absolute. Workspace names and account names are arbitrary letters, numbers, underscores, and hyphens. Routes referencing unknown workspaces fail validation.

- `workspaces` maps names to existing project directories. `routes` maps Discord account/guild/channel combinations to a workspace, model, and effort.
- `conversationMode: "channel"` keeps a single conversation in the channel. Omit it to create task threads. `requireMention` defaults to true.
- `concurrency` limits active tasks globally, from 1 to 32. `timezone` sets the schedule default; it defaults to UTC. Individual schedules can override it.
- `agent.name` sets the bot's prompt identity. `agent.instructions` replaces the default task instructions. Protocol and file-delivery requirements still need to be respected by custom instructions.
- `agent.sandbox` accepts `read-only`, `workspace-write`, or `danger-full-access`. The default is `workspace-write`. Interactive tool approvals are rejected because the transports do not implement an approval UI.
- `dataDir` holds private state and runtime snapshots. `secretsDir` holds transport credentials. `codexHome` selects the CLI's private authentication/configuration directory. `codex` is the executable path.

No model is selected in source code. Discord routes and the WhatsApp settings supply model and effort explicitly. Inherited Codex MCP servers and plugins are disabled; this runtime attaches its own tools.

## Optional WhatsApp

Discord and WhatsApp can run separately or together. Set `routes` to `[]` for WhatsApp only. Add these fields to `config.json`, using your own values:

```json
{
  "whatsappGroup": "YOUR_GROUP_ID@g.us",
  "whatsappWorkspace": "default",
  "whatsappAccount": "mobile",
  "whatsappModel": "YOUR_MODEL_ID",
  "whatsappEffort": "medium"
}
```

With the service stopped, run `pnpm pair:whatsapp`. Enter your phone number locally, then enter the displayed pairing code in WhatsApp's Linked devices flow. Do not share that code or the generated credentials. Run `pnpm doctor`, then `pnpm start`.

The first start imports the paired session into private SQLite storage. Pairing files alone do not replace an existing imported session. Back up the entire private data directory before any session migration. This adapter uses Baileys, a third-party WhatsApp Web client, rather than the official WhatsApp Business API.

## State and updates

Back up `dataDir`, `secretsDir`, and `codexHome` privately. Never publish runtime snapshots, database files, transcripts, or generated skill/memory repositories. Runtime snapshots include operator configuration even though runtime Git commits exclude it.

See [self-editing](#self-editing-between-turns) for the draft and publication workflow. Changes to connections, bootstrap code, workspace setup, or the schedule timezone require a controlled service restart. Upgrading from the initial permanently pinned edition requires one service restart to install the new supervisor; later task-runtime patches apply between turns.

Use your process manager to run `pnpm start` with the repository as its working directory. SIGTERM shuts down connections and marks active work interrupted. On restart, uncertain tool execution or outgoing deliveries are not blindly replayed. Reply to an interrupted task to continue. Upgrade the Codex binary yourself after checking compatibility; there is no automatic binary updater.

## Development

```sh
pnpm check
pnpm test
pnpm build
pnpm audit:export
```

Tests use temporary directories, fake RPC responses, and mocked platform clients. They do not send live messages or consume model tokens. CI runs these checks on Linux. Before publishing, also run a dedicated secret scanner against the full Git history.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the module layout and [the export audit notes](docs/export-audit.md) for publication checks. MIT licensed.
