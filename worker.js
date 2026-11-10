/**
 * Web Studio — Cloudflare Worker entry point.
 *
 * The Worker only serves the static production build through the Static
 * Assets binding. No user code is ever executed on the server; all editing
 * and preview execution happens locally in the user's browser inside a
 * sandboxed iframe.
 */
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  }
};
