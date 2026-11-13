# TriPane: notes for working on this project

## Rule: injecting JS or CSS into pages is the last option

TriPane exists to show how pages really behave in each engine. Anything TriPane puts into a page
can change that behaviour, or be detected by it. So before adding code that runs inside or
changes the inspected page, use the first option that works:

1. **Playwright's public API** (`page`, `locator`, `context`, `mouse`, `keyboard`, `route`,
   `screenshot`, `emulateMedia`, …).
2. **The engine's own protocol**, where Playwright exposes it: CDP for Chromium
   (`context.newCDPSession`). If that leaves Firefox or WebKit without the feature, accept that
   or fall back to option 3. Don't use Playwright's private internals to reach their protocols.
3. **A read-only `page.evaluate()` run on demand**: it reads and returns, and leaves nothing
   behind (no globals, no DOM changes, no patched prototypes, no listeners).
4. **Injection, as a last resort.** This covers init scripts (`addInitScript`), exposed bindings,
   patched built-ins, page globals, and injected DOM or CSS (overlays, `<style>`). Only when 1–3
   can't do the job, and then:
   - say in the code why nothing else works;
   - keep it as small as possible: the narrowest scope, only while needed, removed afterwards;
   - prefer a closed shadow root for UI, and never patch built-ins (`EventTarget.prototype`, …);
   - don't run it on every page unless the feature needs that; prefer on demand or opt-in;
   - add it to the list below.

Ask before adding a new injection.

### Injections that exist today, and why

| Where | What | Why there's no alternative |
| --- | --- | --- |
| `server/pane.ts`: `NO_BACKSPACE_NAVIGATION` | Init script in every page: stops Backspace from navigating back (only when the key goes to a non-editable element and the page didn't handle it). | Playwright's WebKit still has Backspace = Back on Windows and macOS. With Follow links on, it sent all three panes back. No browser setting or Playwright option turns it off. |
| `server/element-ref.ts`: `drawHighlight` | Hover and Compare outline in Firefox and WebKit: a closed-shadow-root overlay, removed when the highlight clears. | Chromium uses its native DevTools overlay (CDP `Overlay.highlightNode`); Firefox and WebKit have no overlay that Playwright exposes. |
| `server/cdp/inspector.ts` + `server/cdp/agent.ts` | Chrome DevTools for Firefox and WebKit: an exposed binding and an init script that model the DOM for the Elements panel. Installed only once DevTools is opened on that engine. | Playwright doesn't expose Firefox's or WebKit's own inspector protocols, so the Elements panel has to be built inside the page. |

## Other conventions

- Commit only when asked.
- Run from source with `bun start`. Run tests with `bun test` (all three engines, real browsers) and `bun run typecheck`.
- Bun lives at `~/.bun/bin`.
