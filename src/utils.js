/**
 * utils.js — small shared helpers.
 */

/** Debounce a function. */
export function debounce(fn, wait = 300) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/** Escape HTML special characters (used for rendering names in the UI). */
export function escapeHtml(str = '') {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Generate a reasonably unique id. */
export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Sanitize a file path from an imported archive.
 * Rejects absolute paths, `..` traversal and backslashes abuse.
 * Returns a normalized relative path or null when unsafe.
 */
export function sanitizePath(rawPath) {
  if (typeof rawPath !== 'string') return null;
  let p = rawPath.replaceAll('\\', '/').trim();
  if (!p || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  const parts = p.split('/').filter((s) => s.length > 0);
  for (const part of parts) {
    if (part === '.' || part === '..') return null;
  }
  p = parts.join('/');
  if (!p || p.length > 255) return null;
  return p;
}

/** Extension helpers. */
export function extOf(path = '') {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

export function isSupportedFile(path) {
  return ['html', 'htm', 'css', 'js', 'mjs', 'json', 'svg', 'txt', 'md'].includes(extOf(path));
}

export function baseName(path = '') {
  return path.split('/').pop();
}

export function dirName(path = '') {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/');
}

/** Format bytes for storage info display. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Toast notifications. Reuses one container; safe to call repeatedly. */
export function toast(message, type = 'info', timeout = 3200) {
  let container = document.getElementById('ws-toasts');
  if (!container) {
    container = document.createElement('div');
    container.id = 'ws-toasts';
    container.className = 'toasts';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', 'status');
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 350);
  }, timeout);
}

/** Confirmation dialog (native confirm is fine for a local-first tool). */
export function confirmDialog(message) {
  return window.confirm(message);
}

/** Download a Blob as a file. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
