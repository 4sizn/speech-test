# Engine Profile Refactor Implementation Plan

> **For Hermes:** implement with test-first steps; keep `rvs-stt-kit` public API unchanged.

**Goal:** make speech-test select ASR Engine Profiles rather than conflating model and Provider, while supporting FunASR streaming and offline profiles without advertising offline as immediate conversation.

**Architecture:** retain `SttProvider` implementations as transport adapters. Add a speech-test-local profile catalog with engine metadata (`partialStrategy`, `conversation`, languages, runtime, endpoint). UI selects a profile; the engine resolves its transport provider and configuration. The WebSocket server accepts profile-specific engine identifiers and emits typed transcript metadata compatibly.

**Tasks:**
1. Add failing profile catalog tests covering streaming/offline FunASR classification and conversation filtering.
2. Add local EngineProfile catalog and registry resolution without changing rvs-stt-kit exports.
3. Update speech-test provider selection UI/state to select profiles and preserve legacy provider preferences through a migration map.
4. Add `funasr-offline` server adapter and profile-specific server selection.
5. Record per-profile partial strategy and first-partial timing in QA.
6. Run Node 24 check/build/kit tests, targeted profile QA, browser E2E, independent post-review, commit/push.

**Non-goals:** Fun-ASR-Nano/vLLM deployment; changing rvs-stt-kit contracts; promising incremental partials for offline profiles.
