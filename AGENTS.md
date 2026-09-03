# Project instructions

## Purpose

Build a private, local-only bridge between one Douyin friend account and Codex App Server.

## Run and verify

- Use Node.js 22 or newer; the current verified runtime is Node.js 24.
- Run `npm test` after changing JavaScript.
- Run `npm run smoke:codex` after changing the App Server integration.
- Run `npm run probe:douyin` before any CDP inspection.

## Stack and structure

- `src/` contains dependency-free Node.js clients.
- `scripts/` contains bounded smoke tests, launchers, and diagnostics.
- `fixtures/` contains non-sensitive test data only.
- `private/` is reserved for sensitive local-only material and is excluded from Git.
- The live bridge loads the existing private persona from `%USERPROFILE%\.codex\AGENTS.md` and never copies it into this repository.

## Safety and privacy

- Never commit or print phone numbers, verification codes, cookies, tokens, chat text, or private persona content.
- Bind debugging and bridge endpoints to localhost only.
- Keep outbound Douyin message sending disabled until read-only detection is verified for the intended chat.
- Do not terminate or restart Douyin automatically; require the user to exit it before debug launch.

## Current state

- Codex App Server startup and `AGENTS.md` loading are verified.
- Douyin 8.3.0 Electron rejects the safe bootstrap path; Windows UI Automation is also insufficient.
- The active route is a dedicated Edge profile on localhost CDP port 9229.
- The dedicated Edge profile is authenticated, and the current chat input/list/message structure is mapped.
- One controlled text message completed an inbound/outbound live round trip through Codex App Server.
- One native shared-video card completed an inbound/outbound live round trip using local H.264 keyframes as Codex `localImage` inputs.
- The live bridge derives a full SHA-256 chat key from the selected opponent's opaque account id, locks that chat, orders reverse-DOM messages by visual position, and refuses startup when stable identity is unavailable. Identity prefers the right-panel profile and narrowly falls back to the selected conversation row's avatar `secUid`; neither path returns the identifier itself.
- Incoming/outgoing direction is derived from Douyin's stable `isFromMe` DOM marker rather than live horizontal geometry, so background, minimized, or narrow Edge layouts do not collapse every message to the center.
- Message fingerprints use the stable active content area and exclude both the dynamic time label and the bottom reaction panel, so day-boundary label changes or media likes do not invalidate a persisted append boundary.
- Each chat key maps to one persistent Codex App Server thread. Restart uses `thread/resume` without reinjecting history; a confirmed missing or incompatible thread starts fresh and seeds visible history once while retaining a reliable message checkpoint.
- Bridge state is allowlisted metadata under ignored `.runtime/douyin-bridge-state/v1/`, written as atomic primary and recovery snapshots. Neither copy contains chat text, names, account ids, tokens, persona text, or media URLs.
- A Windows named-pipe run lock prevents two bridge processes from owning the same chat and is released automatically when a process terminates.
- Shared videos now use duration-tiered adaptive sampling: 5 frames for short clips, rising through 8/12/16 to an 18-frame hard cap for long videos.
- The localhost Edge media page scans at most 72 sequential 16x10 RGB signatures in memory, then preserves temporal coverage and scene changes, removes similar interior frames, and writes only final 768px-bounded PNGs.
- SenseVoice uses its verified FSMN-VAD SRT protocol for real speech/tag time anchors when supported; unsupported or invalid timing degrades to visual selection without inferred timestamps.
- New text and native shared-video messages are handled in that same thread; video files, extracted WAV audio, and final frames are deleted after the Codex turn.
- Stale UUID media-job directories older than two hours are removed on the next bridge or video-tool start; unrelated `.runtime/video-analysis` directories are left alone.
- Shared-video audio is decoded locally by Edge, then transcribed offline by the pinned SenseVoiceSmall Q8 llama.cpp runtime with language, emotion, and event tags.
- Shared-video downloads prefer exact official playback hosts before trusted CDN fallbacks, follow at most two trusted redirects, probe total size with one byte, and assemble at most three concurrent verified 1 MiB ranges in original order. Each range gets at most three attempts, is buffered only up to its 1 MiB bound, is written only after exact validation, and refreshes its official playback redirect on retry. All candidates share a six-minute wall-time budget; each request fails after 30 seconds without network activity. Media work remains bounded by 100 MB per video, 15 minutes per audio track, 40 MiB per WAV upload, 45 seconds each for scene scanning and final capture, 4 MiB per PNG, and 64 MiB for all final PNGs.
- SenseVoice binaries and models live only under the ignored `.runtime/tools/sensevoice/` directory and are verified by `npm run setup:sensevoice`.
- The live model defaults are pinned to `gpt-5.6-sol` with `xhigh` reasoning; startup validates both against `model/list`.
- Persona instructions are loaded dynamically from `%USERPROFILE%\.codex\AGENTS.md` on every thread start or resume and are never copied into this repository.
- The bridge persists queued/processing/reply/send phases and verifies the exact expected outbound fingerprint. A verified reply advances only its own queue item, so restart resumes the remaining hash-only queue without repeating completed replies. It stops on chat changes, unknown outgoing activity, ambiguous in-flight recovery, checkpoint gaps, or unverified sends.
- Read-only mode observes without starting Codex turns or advancing the persisted message checkpoint.
- The live bridge uses App Server `thread/tokenUsage/updated` values and official `thread/compact/start` for automatic context compaction. It waits for the `contextCompaction` item and its turn to complete, only runs while turn/media/send activity is idle, and applies high/low hysteresis, cooldown, and single-flight protection.
- A terminal `contextWindowExceeded` gets one conservative compact-and-retry attempt; compaction failures emit content-free structured diagnostics and leave the bridge available for later messages.
- A localhost-only supervisor and dashboard manage the dedicated Edge window, bridge lifecycle, model/effort selection, context usage, manual compaction, and explicit fresh-thread rotation. New installations default to read-only mode; automatic sending must be enabled after the intended chat is verified. Automatic restart is limited to non-dangerous idle failures; unsafe phases remain blocked.
- The bridge detects the observed normal-window/collapsed-renderer mismatch and repairs it with a bounded one-pixel window nudge; it never restores a deliberately minimized Edge window.
- Windows logon autostart uses the fixed scheduled-task name `CodexDouyinFriendSupervisor`, an interactive limited user principal, and an exact Node action that directly owns the supervisor process; Task Scheduler restart and the supervisor named-pipe singleton remain bounded.
- Direct chat images, ordered image posts, and cover-only fallbacks enter the same Codex thread as `localImage` inputs. Text preceding the first media item and consecutive text immediately following each media item are preserved in that media turn. Direct images prefer a bounded, signature-checked visible data image or trusted CDN source and fall back to a bounded screenshot without relying on background `requestAnimationFrame`. Shared-work detail requests use three attempts, a two-second per-request cutoff, bounded backoff, and a 15-second outer CDP evaluation budget before falling back to bounded React data with an explicit evidence boundary. Ignored UUID jobs are deleted after each turn and stale jobs older than two hours are cleaned on startup.
- Shared-work recognition is driven by a static variant registry covering both `.MessageItemShareAwemecontainer` and `.BulletBulletVideocontainer`. Item, video, image, cover, and dynamic-card fields accept their observed camelCase and snake_case forms. Resolution distinguishes compatible video, ordered multi-image posts, confirmed single-image posts, and cover-only fallback; unknown media emits only a bounded hash/count/class-name/attribute-name diagnostic and stops safely without runtime code mutation.
- Direct chat WebP payloads are never passed through as `localImage`: the bridge requires declared MIME and byte signatures to agree and falls back to a bounded PNG screenshot. The 2026-09-03 real direct-image sample passed a `gpt-5.6-sol` visual question after this conversion path.
- Shared-comment cards preserve the comment author, comment body, and associated-work title as untrusted media context, separately from any sender-attached chat text. Their referenced work reuses the full video/image/cover pipeline, and the model is told not to confuse the commenter with the chat sender.
- Live media probes on 2026-09-02 exposed the former compound-message, zero-width direction, background-screenshot, and null-detail failures. After correction, the current real direct-image data payload and share-card cover both completed bounded local acquisition and immediate cleanup; a combined text plus share-card cover also completed a fresh-thread Codex reply and verified Douyin send. On 2026-09-03, a privacy-safe read-only probe resolved three visible shared-work cards to full H.264 video sources through the bounded detail path. Two adjacent real shared videos then completed ordered replies and verified likes; failures while processing the second preserved the first verified boundary, and the recovered second item later completed with full frames, audio, send verification, and immediate cleanup.
- On 2026-09-03, one `.BulletBulletVideocontainer` single-image work followed by a text message was recovered from its exact two-item `processing` checkpoint into one media turn. Exactly one reply was generated and verified in Douyin, both state copies advanced to an empty `ready` checkpoint, media cleanup completed, and the scheduled supervisor returned to `listening` without repeating an older reply.
- On 2026-09-03, one real shared-comment card completed comment extraction, associated-video frame/audio processing, Codex generation, verified Douyin send, viewport recovery, and immediate media cleanup.
- Optional media likes are disabled by default and configured only in ignored supervisor state. The model makes the decision in the existing media turn using a nonce-bound marker that is stripped before sending; after a verified reply, the bridge re-identifies the exact locked incoming media, invokes only the visible exact `点赞` menu item, and verifies that it disappeared. A real chat image like and the already-liked no-op path were both verified on 2026-09-03. Mention-based `@` triggers remain intentionally unsupported.
- Append recovery and the persistent inbound queue are bounded to the latest 12 visible DOM messages. A fixed-size DOM window may slide only when at least two consecutive hashed messages establish the old-suffix/new-prefix boundary; missing boundaries still fail closed. Automatic recovery resumes an exact queued checkpoint and still refuses ambiguous processing/reply-ready turns; explicit fresh-thread rotation may preserve an exact paused queue, rewind a tail pending boundary, or rebind an interrupted later queue item before an already-verified reply only when the entire current snapshot still matches its checkpoint.
- New inbound activity gets a bounded three-round, 750 ms quiet-window settle. Supported messages are planned chronologically: consecutive text before the first media item and consecutive text immediately after each media item join that media turn, while adjacent media items remain separate turns. Pure-text input remains one text turn. Each media reader re-identifies its exact queued fingerprint and ordinal instead of assuming the newest card.
