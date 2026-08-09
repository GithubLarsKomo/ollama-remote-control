# Wave 2x.1 — Current Ollama Modelfile parity

This compatibility slice follows Wave 2x and tracks current upstream Ollama parser/API behavior before any model-create workflow is introduced.

## Added first-class directives

- `DRAFT` — speculative/draft model source used by current Ollama creation flows.
- `RENDERER` — renderer identifier used when constructing requests.
- `PARSER` — parser identifier used when interpreting model output.

The shared parser now recognizes these directives instead of classifying them as opaque future syntax. Raw source remains canonical and lossless.

## Structured editing boundary

All three directives are treated as conservative singletons. The structured editor provides simple one-line controls and preserves source-range patching semantics. If raw source contains a multiline/triple-quoted form for one of these directives, it remains byte-identical but that node is marked raw-only and receives a local diagnostic rather than being rewritten.

No browser-side path, model, renderer, or parser lookup is attempted. In particular, `DRAFT` values are not asserted to exist remotely or locally by the editor.

## Upstream evidence

Current Ollama parser tests explicitly cover `DRAFT`, `RENDERER`, and `PARSER`; current API types expose renderer/parser fields and draft-aware model creation paths. This document records compatibility intent only; Ollama remains the authority for deployment-time validation.

## Out of scope

- `ollama create` or model deployment
- validation of referenced local paths or model availability
- automatic renderer/parser discovery
- lineage/source resolution

Wave 2y may consume immutable revisions only after deployment-specific validation and explicit confirmation.
