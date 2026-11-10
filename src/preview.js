/**
 * preview.js — sandboxed live preview.
 *
 * The preview runs inside a sandboxed iframe (allow-scripts only — no
 * allow-same-origin, so it runs in a unique opaque origin and cannot touch
 * the app's storage, DOM or cookies). All user code is treated as untrusted
 * and is never executed on the server or in the app's own context.
 *
 * The preview document embeds a small console/error bridge BEFORE user code
 * runs; it forwards console output and runtime errors to the parent via
 * postMessage with a fixed source tag.
 */

const BRIDGE_SCRIPT = `
(function () {
  var SOURCE = 'web-studio-preview';
  function send(payload) {
    try { parent.postMessage(Object.assign({ source: SOURCE }, payload), '*'); } catch (e) {}
  }
  window.addEventListener('error', function (event) {
    send({ kind: 'error', message: event.message, line: event.lineno, col: event.colno });
  });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    send({ kind: 'error', message: 'Unhandled promise rejection: ' + (reason && reason.message ? reason.message : String(reason)) });
  });
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var original = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        try {
          parts.push(typeof arguments[i] === 'object' && arguments[i] !== null ? JSON.stringify(arguments[i]) : String(arguments[i]));
        } catch (e) { parts.push('[unserializable]'); }
      }
      send({ kind: 'console', level: level, text: parts.join(' ') });
      original.apply(console, arguments);
    };
  });
})();`;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Inline local <link rel=stylesheet href="..."> and
 * <script src="..."> references that match project files, so a multi-file
 * project previews correctly inside the single srcdoc document.
 */
function inlineLocalAssets(htmlStr, fileMap) {
  // <link rel="stylesheet" href="style.css">
  htmlStr = htmlStr.replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi, (tag) => {
    const m = tag.match(/href=["']([^"']+)["']/i);
    if (!m) return tag;
    const path = m[1].replace(/^\.?\//, '');
    if (fileMap.has(path)) {
      return `<style>\n${fileMap.get(path)}\n</style>`;
    }
    return tag;
  });
  // <script src="script.js"></script>
  htmlStr = htmlStr.replace(/<script\b[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (tag, src) => {
    const path = src.replace(/^\.?\//, '');
    if (fileMap.has(path)) {
      return `<script>\n${fileMap.get(path)}\n</script>`;
    }
    return tag;
  });
  return htmlStr;
}

export class Preview {
  /**
   * @param {HTMLIFrameElement} iframe
   * @param {object} handlers { onError(data), onConsole(level, text), onReady() }
   */
  constructor(iframe, handlers = {}) {
    this.iframe = iframe;
    this.handlers = handlers;
    this._lastDoc = '';
    this._messageHandler = (event) => {
      const data = event.data;
      if (!data || data.source !== 'web-studio-preview') return;
      if (data.kind === 'error') this.handlers.onError?.(data);
      else if (data.kind === 'console') this.handlers.onConsole?.(data.level, data.text);
    };
    window.addEventListener('message', this._messageHandler);
  }

  destroy() {
    window.removeEventListener('message', this._messageHandler);
  }

  /**
   * Render and run the preview.
   * @param {object} params { html, cssFiles: [{path,content}], jsFiles: [{path,content}] }
   */
  render({ html = '', cssFiles = [], jsFiles = [] }) {
    const fileMap = new Map();
    for (const f of [...cssFiles, ...jsFiles]) fileMap.set(f.path, f.content);

    // Strip any pre-existing <script src> for js files (re-injected below in
    // a controlled order) and inline css/js assets into the document.
    let bodyHtml = inlineLocalAssets(html, fileMap);

    const css = cssFiles.map((f) => `/* ${f.path} */\n${f.content}`).join('\n\n');
    const js = jsFiles.map((f) => `// ${f.path}\n${f.content}`).join('\n\n');

    const doc = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<script>${BRIDGE_SCRIPT}</script>
<style>
${css}
</style>
</head>
<body>
${bodyHtml}
<script>
try {
${js}
} catch (e) {
  console.error(e && e.message ? e.message : String(e));
}
</script>
</body>
</html>`;

    this._lastDoc = doc;
    // allow-scripts only: the frame runs in a unique opaque origin. No
    // allow-same-origin means it cannot access parent storage/DOM.
    this.iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-modals');
    this.iframe.srcdoc = doc;
    this.handlers.onReady?.();
  }

  refresh() {
    if (this._lastDoc) this.iframe.srcdoc = this._lastDoc;
  }
}
