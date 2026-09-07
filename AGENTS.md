# Project instructions

## Purpose

Build a locally controlled bridge between one dedicated Douyin account, one trusted friend, and Codex App Server. Local endpoints and project state do not imply offline model processing.

## Run and verify

- Use Node.js 22 or newer; the current verified runtime is Node.js 24.
- Run `npm test` after changing JavaScript.
- Run `npm run smoke:codex` after changing the App Server integration.
- Run `npm run probe:douyin` before any CDP inspection.

## Stack and structure

- `src/` contains dependency-free Node.js clients and contract owners.
- `scripts/` contains bounded smoke tests, launchers, diagnostics, and the single live bridge entry point.
- `fixtures/` contains non-sensitive test data only.
- `private/` is reserved for sensitive local-only material and is excluded from Git.
- `.runtime/` contains ignored local state, dedicated browser data, optional tools, and disposable media jobs.
- `README.md` is the authoritative current-state, operating, evidence, and release-boundary document. Keep dated field evidence there rather than in this rule file.

## Safety and privacy

- Never commit or print phone numbers, verification codes, cookies, tokens, chat text, private persona content, media URLs, account ids, or raw DOM payloads.
- Bind debugging, media, supervisor, and bridge endpoints to localhost only.
- Keep outbound Douyin sending and optional media likes disabled until read-only detection is verified for the intended chat.
- Do not terminate, restart, restore, focus, or switch Douyin automatically. The dedicated Edge window may be repaired only through the existing bounded viewport path, which must never restore a deliberately minimized window.
- The live bridge loads the existing private persona from `%USERPROFILE%\.codex\AGENTS.md`; never copy it into this repository. Companion threads must use the dedicated repository-external runtime cwd and accept exactly the expected instruction-source sequence.
- Project state and logs are allowlisted metadata. Message text, reply text, prompt bodies, persona text, transcripts, and media sources remain out of project persistence.
- Codex task history is governed by the signed-in account's product retention settings; do not describe persistent companion threads as ephemeral or local-only model processing.

## Product contracts and owners

- The supported contracts are persona-preserving text, direct chat images, shared videos, single/multi-image works, shared comments with their associated work, adjacent text joined to its media turn, optional post-reply media likes, and ordered native built-in emoji.
- `douyin-inbound-planner.mjs` owns message batching and action-id recovery of the committed first batch.
- `douyin-chat-page.mjs` owns static DOM recognition and hash-only message metadata.
- `douyin-media-pipeline.mjs` owns static media adapter selection; image/video/player runtimes own bounded local evidence and cleanup.
- `douyin-message-quote.mjs` owns exact-target native quote binding and cleanup.
- `douyin-action-journal.mjs` owns external-action identity and monotonic stages. `douyin-bridge-state.mjs` owns persisted checkpoint validation and recovery.
- `run-douyin-bridge.mjs` is the only production sender and browser side-effect coordinator. Diagnostic entry points are observation/generation-only and must share the run lock.
- `codex-app-server-client.mjs` owns JSON-RPC transport, turn-start durability gating, and authoritative completed-reply selection. Commentary never becomes a Douyin reply.
- Shared orchestrators coordinate these owners; do not move media policy, protocol parsing, persistence, DOM actions, and cleanup into a second competing path.

## Recovery and side-effect boundaries

- One locked chat maps to one persistent Codex thread and one Windows named-pipe bridge owner. Model and reasoning settings are validated against `model/list`.
- An action id commits the exact ordered input batch. Recovery may consume only the unique input prefix proved by that id under the bounded ordinal-shift contract; later input remains queued.
- A turn id must be durable before completion can advance the bridge. Live completion and `thread/read` must select the same unique completed `final_answer`.
- Enter is at most once: persist `send-attempted`, recheck the complete chat/editor/quote authority gate, press Enter, then require the exact outgoing bubble before advancing. An uncertain Enter result is never blindly resent.
- Internal `send-verified` means only that the sender-side DOM exposed the expected outgoing fingerprint. It is not a platform ACK and does not prove recipient delivery; user-facing status must say `local-dom-observed` or equivalent.
- Optional reactions occur only after local outgoing-bubble evidence. Rebind their exact media occurrence before Enter, persist `reaction-attempted` before clicking, never repeat a recorded attempt, and abandon only the optional reaction when its target cannot be proved.
- Persisted state has atomic primary and recovery copies but no global transactional filesystem. Preserve the journal/turn receipt on safety errors; never replace stronger evidence with a generic blocked record.
- Recognized platform system cards update only the snapshot boundary. Unknown right-side content must persist a degraded phase that pauses sending while polling continues; recover automatically only after a stable snapshot reconciles the outbound ledger. Only a missing committed outbound fingerprint or an extra known outbound item is an outbound-ledger contradiction that may block the bridge.
- The inbox/checkpoint contract is bounded to the latest 12 visible DOM messages. Detectable missing overlap, chat/page identity change, unsupported recovery, or a target outside the visible evidence window must stop explicitly. Different histories can collapse to the same finite hash snapshot without detection, so this is not a continuous or durable inbox.
- Keep one browser side-effect owner. Do not add a second CDP worker that scrolls, opens media, edits, sends, quotes, or reacts concurrently.

## Runtime and release discipline

- Media acquisition is bounded by the limits documented in `README.md`; successful and failed jobs must clean their exact ignored UUID directory. Stale cleanup may touch only owned jobs covered by the established retention rule.
- SenseVoice is optional. Missing or invalid local speech tooling degrades explicitly to visual-only evidence and must not prevent bridge startup.
- Unknown media may emit only the existing bounded, content-free structure diagnostic. Runtime discovery never edits source code or relaxes validators.
- Supervisor terminal events are strict allowlists. Verified boundary or outbound-ledger contradictions block; persisted unknown-right degradation keeps polling. Recoverable idle failures use the documented bounded backoff. Never weaken a gate to keep the dashboard green.
- Automatic sending and media likes default off. Releases remain limited to one trusted friend and dedicated account/profile until a stable platform message identity or another approved durable-ingestion source exists.
- Before completion, inspect the full diff and Git status; remove task-created scratch files, temporary processes, listeners, and media jobs; update `README.md` when behavior or release truth changes.
