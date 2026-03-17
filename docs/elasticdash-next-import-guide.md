# Importing elasticdash-test in a Next.js project

## The problem

`elasticdash-test` is a **worker-only package**. It runs inside the
`elasticdash` test subprocess and is never available in the Next.js server
runtime or build. When Next.js encounters a reference to it — static or
dynamic — it tries to resolve and bundle it, which fails.

There are two distinct failure modes:

| Symptom | Cause |
|---|---|
| `⨯ Module not found: Can't resolve 'elasticdash-test'` (hard error) | A **static top-level import** in a file that Next.js bundles (e.g. `route.ts`) |
| `⚠ Module not found: Can't resolve 'elasticdash-test'` (warning) | A **dynamic `import()`** inside a function in a file Next.js scans (e.g. `ed_tools.ts`) |

---

## Rule of thumb

> **Never statically import `elasticdash-test` in any file that is part of
> the Next.js module graph** (any file under `app/`, `pages/`, `components/`,
> `utils/`, `services/`, etc.).

The only files that may reference `elasticdash-test` are:

- `ed_workflows.ts` — the workflow entry point, only imported by the
  `elasticdash` CLI, never by Next.js.
- `ed_tools.ts` — same, but uses a dynamic import guarded by
  `ELASTICDASH_WORKER`.
- Any standalone file imported exclusively by `ed_workflows.ts` or
  `ed_tools.ts` (see the "separate file" pattern below).

---

## Fix 1 — Static import in a Next.js route file (hard error ⨯)

**Wrong** — `elasticdash-test` statically imported inside `app/api/.../route.ts`:

```ts
// app/api/chat-stream/route.ts  ← Next.js bundles this
import { wrapTool, readVercelAIStream } from 'elasticdash-test'   // ⨯ build error
```

**Fix** — Extract the test wrapper into a **sibling file** that Next.js never
imports:

```
app/api/chat-stream/
  route.ts              ← Next.js route, no elasticdash imports
  chatStreamHandler.ts  ← test wrapper, only imported by ed_workflows.ts
```

`chatStreamHandler.ts` holds the `wrapTool` call and re-exports
`chatStreamHandler` + `ChatStreamResult`. `route.ts` exports only `POST`.
`ed_workflows.ts` imports from `chatStreamHandler.ts` directly, not from
`route.ts`.

```ts
// ed_workflows.ts
export { chatStreamHandler } from './app/api/chat-stream/chatStreamHandler'
export type { ChatStreamResult, ChatStreamInput } from './app/api/chat-stream/chatStreamHandler'
```

Next.js never traces into `chatStreamHandler.ts` because `route.ts` does not
import it. The elasticdash CLI reaches it through `ed_workflows.ts`.

---

## Fix 2 — Dynamic import in a scanned file (warning ⚠)

Next.js webpack scans every `.ts` file in the project for `import()` calls.
Even a dynamic import string like `await import("elasticdash-test")` inside an
`if` guard generates a warning because webpack tries to statically analyse all
import expressions.

**Fix** — Declare `elasticdash-test` as a server external in `next.config.js`:

```js
// next.config.js
const nextConfig = {
  serverExternalPackages: [
    // ... existing entries ...
    'elasticdash-test',
  ],
}
```

`serverExternalPackages` tells the Next.js webpack bundler to treat the
package as a Node.js external — it will not attempt to bundle or resolve it at
build time. The dynamic `import()` in `ed_tools.ts` is then left as-is and
resolved at runtime by Node.js (only inside the worker subprocess where the
package is available).

---

## Summary checklist

- [ ] `elasticdash-test` is in `serverExternalPackages` in `next.config.js`
      → suppresses the dynamic-import warning in `ed_tools.ts` and any other
        scanned file
- [ ] No static top-level `import … from 'elasticdash-test'` inside any
      `app/`, `pages/`, `utils/`, `services/`, or `components/` file
- [ ] Test wrappers (files that use `wrapTool`, `readVercelAIStream`, etc.)
      live in standalone files imported **only** by `ed_workflows.ts`
