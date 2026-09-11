Shared TypeScript types for the Hub ↔ Agent HTTP contract.

Canonical definitions live in [`api.ts`](api.ts). The Hub keeps a mirrored copy under `hub/src/types.ts` for the Node build (no cross-package bundling in MVP).

When you change a request/response shape here, update `hub/src/types.ts` in the same PR. The Go agent uses structurally matching JSON tags rather than generating from this file.
