// TriPane makes many Playwright calls of its own: Firefox and WebKit frames (a screenshot up to 15
// times a second), hover highlight, scroll sync, titles, console formatting, DevTools requests.
// In a trace (Tools → Record trace) they would bury what the user did, so they run as
// Playwright-internal calls, the way Playwright runs its own bookkeeping: traces leave those out.
//
// This uses a private Playwright method (ChannelOwner._wrapApiCall); every call made inside `run`
// (on any page, context or session) is internal. If a Playwright upgrade removes the method,
// the calls simply run as before and show up in traces (test/trace.test.ts would notice).

type ApiOwner = { _wrapApiCall?: <T>(run: () => Promise<T>, options: { internal: boolean }) => Promise<T> };

/** Runs TriPane's own Playwright calls so traces leave them out. `owner`: any page, context or CDP session. */
export function quietly<T>(owner: object | undefined, run: () => Promise<T>): Promise<T> {
  const wrap = (owner as ApiOwner | undefined)?._wrapApiCall;
  return typeof wrap === 'function' ? (wrap.call(owner, run, { internal: true }) as Promise<T>) : run();
}
