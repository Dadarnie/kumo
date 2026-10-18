# Mimo — Windows integrations

The current native service pollers are in `windows/src-tauri/src/integrations.rs`.
Frontend ownership stays in `src/core/modules.ts`, `module-lifecycle.ts`,
`src/island/integrations.ts` and `src/views/integrations.ts`. Disabling a module
retains the existing detach/prune behavior; re-enabling starts one subscription.

| Service | Existing module ID   | Credential key(s)        |
| ------- | -------------------- | ------------------------ |
| n8n     | `integration_n8n`    | `n8n-url`, `n8n-api-key` |
| Vercel  | `integration_vercel` | `vercel-token`           |
| GitHub  | `integration_github` | `github-token`           |
| Stripe  | `integration_stripe` | `stripe-api-key`         |
| Resend  | `integration_resend` | `resend-api-key`         |
| Notion  | `integration_notion` | `notion-api-key`         |
| Cal.com | `integration_calcom` | `calcom-api-key`         |

Credentials are optional and use Windows Credential Manager under the
`com.johnpaul.mimo` service. The frontend can ask whether a credential
is present; it does not receive stored secret values. Polling intervals, payloads,
pause behavior and refresh commands remain defined by the working native code.
The pollers share the existing `integration` event channel.

Claude Code is a separate hook integration using the bundled Windows relay and
named pipe; see [AGENTS.md](agents.md). Claude chat uses the existing
`anthropic-api-key`, `claude.rs` and streamed bridge events. File drop retains the
local inbox and current ingestion limits in `files.rs`.

When changing an integration in future, verify its official API documentation and
preserve existing module IDs, credential keys, settings semantics and event shapes.
