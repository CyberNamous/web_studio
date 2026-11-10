/**
 * app.js — Web Studio application core.
 *
 * Wires together: state/projects (storage.js), the CodeMirror editor
 * (editor.js), the sandboxed preview (preview.js), the xterm terminal
 * (terminal.js), settings UI, ZIP import/export, and desktop/mobile layout.
 */
import { createIcons, icons } from 'lucide';
import Split from 'split.js';

import {
  loadSettings, saveSettings, DEFAULT_SETTINGS,
  saveProject, loadProject, deleteProject, listProjects,
  createStarterProject, createEmptyProject, estimateStorage
} from './storage.js';
import { Editor, EDITOR_THEMES } from './editor.js';
import { Preview } from './preview.js';
import { TerminalPanel } from './terminal.js';
import { APP_VERSION } from './version.js';
import {
  debounce, escapeHtml, sanitizePath, extOf, baseName, dirName,
  formatBytes, toast, confirmDialog, downloadBlob
} from './utils.js';

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

const MOBILE_QUERY = '(max-width: 760px)';

const app = {
  settings: loadSettings(),
  project: null,
  editor: null,
  preview: null,
  terminal: null,
  isMobile: window.matchMedia(MOBILE_QUERY).matches
};

export { APP_VERSION };

const $ = (sel) => document.querySelector(sel);

function refreshIcons() {
  try { createIcons({ icons }); } catch { /* icons already rendered */ }
}

/* ------------------------------------------------------------------ */
/* Theme handling                                                      */
/* ------------------------------------------------------------------ */

const APP_THEMES = ['dark', 'light', 'midnight', 'dracula', 'nord', 'monokai', 'rosepine', 'solarized-dark'];

export function applyAppTheme(theme) {
  let resolved = theme;
  if (theme === 'system') {
    resolved = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', resolved);
  app.settings.appTheme = theme;
  saveSettings(app.settings);
  syncSettingsUI();
}

export function setTheme(name) {
  if (!APP_THEMES.includes(name)) return false;
  applyAppTheme(name);
  return true;
}

function applyAccent(color) {
  app.settings.accent = color;
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-contrast', '#ffffff');
  saveSettings(app.settings);
}

// Keep system theme in sync while "System" is selected.
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (app.settings.appTheme === 'system') applyAppTheme('system');
});

/* ------------------------------------------------------------------ */
/* Project state                                                       */
/* ------------------------------------------------------------------ */

function setSaveStatus(state) {
  const el = $('#save-status');
  el.classList.remove('dirty', 'saved');
  switch (state) {
    case 'saving': el.textContent = 'Saving…'; break;
    case 'saved': el.textContent = 'Saved'; el.classList.add('saved'); break;
    case 'dirty': el.textContent = 'Unsaved changes'; el.classList.add('dirty'); break;
    case 'failed': el.textContent = 'Save failed'; break;
    default: el.textContent = 'Ready';
  }
}

async function persistProject() {
  if (!app.project) return;
  setSaveStatus('saving');
  try {
    await saveProject(app.project);
    setSaveStatus('saved');
  } catch (err) {
    console.error(err);
    setSaveStatus('failed');
    toast(`Could not save project: ${err.message}`, 'error');
  }
}

const persistDebounced = debounce(persistProject, 900);

function touchProject() {
  if (!app.project) return;
  app.project.updatedAt = Date.now();
  if (app.settings.autoSave) persistDebounced();
  else setSaveStatus('dirty');
}

function activeFilePath() {
  return app.editor?.currentFile?.path || null;
}

function setActiveFile(path, { openIfClosed = true } = {}) {
  const file = app.project.files.find((f) => f.path === path);
  if (!file) return false;
  app.editor.openFile(file);
  renderFileTree();
  renderTabs();
  if (app.isMobile) switchMobileTab('editor');
  return true;
}

/* ------------------------------------------------------------------ */
/* File tree                                                           */
/* ------------------------------------------------------------------ */

function folderIconName(path) {
  const ext = extOf(path);
  if (ext === 'html' || ext === 'htm') return 'file-code-2';
  if (ext === 'css') return 'palette';
  if (ext === 'js' || ext === 'mjs') return 'file-json-2';
  return 'file-text';
}

function buildTreeModel(files) {
  const root = { type: 'dir', name: '', path: '', children: new Map() };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const seg = parts[i];
      const path = parts.slice(0, i + 1).join('/');
      if (!node.children.has(seg)) node.children.set(seg, { type: 'dir', name: seg, path, children: new Map() });
      node = node.children.get(seg);
    }
    node.children.set(parts[parts.length - 1], { type: 'file', name: parts[parts.length - 1], path: file.path });
  }
  return root;
}

function renderTreeNode(node, container, depth = 0) {
  const children = [...node.children.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const child of children) {
    if (child.type === 'dir') {
      const row = document.createElement('div');
      row.className = 'tree-folder';
      row.innerHTML = `<i data-lucide="folder"></i><span>${escapeHtml(child.name)}</span>
        <span class="tree-row-actions">
          <button data-action="new-file-in" data-path="${escapeHtml(child.path)}" title="New file here"><i data-lucide="file-plus"></i></button>
          <button data-action="rename" data-path="${escapeHtml(child.path)}" title="Rename folder"><i data-lucide="pencil"></i></button>
          <button data-action="delete" data-path="${escapeHtml(child.path)}" title="Delete folder"><i data-lucide="trash-2"></i></button>
        </span>`;
      container.appendChild(row);
      const kids = document.createElement('div');
      kids.className = 'tree-children';
      container.appendChild(kids);
      renderTreeNode(child, kids, depth + 1);
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        row.classList.toggle('collapsed');
      });
    } else {
      const row = document.createElement('div');
      row.className = 'tree-file' + (child.path === activeFilePath() ? ' active' : '');
      const dirty = app.editor?.openTabs?.get(child.path)?.dirty;
      row.innerHTML = `<i data-lucide="${folderIconName(child.path)}"></i><span>${escapeHtml(child.name)}</span>${dirty ? '<span class="dirty-dot" title="Unsaved changes"></span>' : ''}
        <span class="tree-row-actions">
          <button data-action="rename" data-path="${escapeHtml(child.path)}" title="Rename file"><i data-lucide="pencil"></i></button>
          <button data-action="delete" data-path="${escapeHtml(child.path)}" title="Delete file"><i data-lucide="trash-2"></i></button>
        </span>`;
      container.appendChild(row);
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        setActiveFile(child.path);
      });
    }
  }
}

function renderFileTree() {
  const tree = $('#file-tree');
  tree.innerHTML = '';
  if (!app.project || app.project.files.length === 0) {
    tree.innerHTML = '<div class="explorer-empty">No files yet.<br />Use the + buttons above to create one.</div>';
    refreshIcons();
    return;
  }
  const model = buildTreeModel(app.project.files);
  renderTreeNode(model, tree);
  refreshIcons();
}

function renderTabs() {
  const tabs = $('#tabs');
  tabs.innerHTML = '';
  if (!app.editor) return;
  for (const [path, entry] of app.editor.openTabs) {
    const tab = document.createElement('button');
    tab.className = 'tab' + (path === activeFilePath() ? ' active' : '');
    tab.setAttribute('role', 'tab');
    tab.innerHTML = `${escapeHtml(baseName(path))}${entry.dirty ? '<span class="dirty-dot" title="Unsaved changes"></span>' : ''}
      <span class="tab-close" role="button" title="Close tab"><i data-lucide="x"></i></span>`;
    tab.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) {
        if (entry.dirty && !confirmDialog(`"${path}" has unsaved changes. Close anyway?`)) return;
        app.editor.closeFile(path);
        renderTabs();
        renderFileTree();
        return;
      }
      setActiveFile(path);
    });
    tabs.appendChild(tab);
  }
  refreshIcons();
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

function buildPreviewParams() {
  if (!app.project) return null;
  const files = app.project.files;
  const htmlFile =
    files.find((f) => f.path === 'index.html') ||
    files.find((f) => extOf(f.path) === 'html');
  if (!htmlFile) return { error: 'no-html' };

  const htmlContent = app.editor?.getContent(htmlFile.path) ?? htmlFile.content;
  const cssFiles = files
    .filter((f) => extOf(f.path) === 'css')
    .map((f) => ({ path: f.path, content: app.editor?.getContent(f.path) ?? f.content }));
  const jsFiles = files
    .filter((f) => ['js', 'mjs'].includes(extOf(f.path)))
    .map((f) => ({ path: f.path, content: app.editor?.getContent(f.path) ?? f.content }));
  return { html: htmlContent, cssFiles, jsFiles };
}

function runPreview() {
  const params = buildPreviewParams();
  if (!params) return;
  if (params.error === 'no-html') {
    appendConsoleLine('error', 'No HTML file found in this project. Create an index.html to see a preview.');
    return;
  }
  clearConsole();
  appendConsoleLine('info', 'Preview reloaded');
  app.preview.render(params);
}

const runPreviewDebounced = debounce(runPreview, 700);

/* Console output ---------------------------------------------------- */

function appendConsoleLine(level, text) {
  const out = $('#console-output');
  const line = document.createElement('div');
  line.className = `console-line ${level}`;
  line.textContent = `[${level}] ${text}`;
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
  if (!out.classList.contains('visible') && level === 'error') {
    out.classList.add('visible');
    $('#btn-console').classList.add('active');
  }
}

function clearConsole() {
  $('#console-output').innerHTML = '';
}

/* ------------------------------------------------------------------ */
/* ZIP import / export                                                 */
/* ------------------------------------------------------------------ */

async function exportProjectZip() {
  if (!app.project) return;
  try {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    const root = zip.folder(app.project.name.replace(/[^\w\- ]+/g, '_') || 'project');
    for (const file of app.project.files) {
      const content = app.editor?.getContent(file.path) ?? file.content;
      root.file(file.path, content);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, `${app.project.name || 'project'}.zip`);
    toast('Project exported as ZIP', 'success');
  } catch (err) {
    console.error(err);
    toast(`Export failed: ${err.message}`, 'error');
  }
}

/** Files that must never be overwritten by an import (app source). */
const PROTECTED_NAMES = ['app.js', 'editor.js', 'preview.js', 'terminal.js', 'storage.js', 'utils.js', 'index.html', 'style.css', 'theme.css'];

async function importProjectZip(file) {
  if (!file) return;
  try {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(file);
    const projectName = baseName(file.name).replace(/\.zip$/i, '') || 'Imported project';

    const files = [];
    const skipped = [];
    const entries = Object.values(zip.files).filter((e) => !e.dir && !e.name.includes('__MACOSX'));
    if (entries.length === 0) {
      toast('This ZIP archive contains no files.', 'error');
      return;
    }
    for (const entry of entries) {
      // Reject archive-traversal and unsafe paths in the RAW entry name first
      // (defense in depth — some zip readers normalize "a/../b" silently).
      if (/(^|\/|\\)\.\.(\/|\\|$)/.test(entry.name) || entry.name.startsWith('/') || /^[a-zA-Z]:/.test(entry.name)) {
        skipped.push(`${entry.name} (unsafe path rejected)`);
        continue;
      }
      const safePath = sanitizePath(entry.name);
      if (!safePath) {
        skipped.push(entry.name);
        continue;
      }
      // Never let imported content overwrite application source files:
      // block any entry whose file name matches a Web Studio source file.
      const base = baseName(safePath);
      if (PROTECTED_NAMES.includes(base)) {
        skipped.push(`${entry.name} (protected application file name)`);
        continue;
      }
      const content = await entry.async('string');
      const binary = safePath.match(/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|mp3|mp4)$/i);
      if (binary) {
        skipped.push(`${entry.name} (binary asset — not supported in this version)`);
        continue;
      }
      files.push({
        id: `file_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        path: safePath,
        content,
        type: extOf(safePath) || 'txt'
      });
    }
    if (files.length === 0) {
      toast('Import failed: no usable text files (html/css/js) found in the archive.', 'error');
      return;
    }
    const project = {
      id: `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: projectName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      files
    };
    await saveProject(project);
    await openProject(project);
    if (skipped.length > 0) {
      toast(`Imported ${files.length} files. Skipped ${skipped.length} unsupported/unsafe entries.`, 'info', 5000);
      console.warn('Skipped archive entries:', skipped);
    } else {
      toast(`Project "${projectName}" imported`, 'success');
    }
  } catch (err) {
    console.error(err);
    toast(`Invalid or corrupted ZIP file: ${err.message}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Project lifecycle                                                   */
/* ------------------------------------------------------------------ */

async function openProject(project) {
  app.project = project;
  app.settings.lastOpenedProject = project.id;
  saveSettings(app.settings);
  $('#project-name-display').textContent = project.name;
  $('#status-project').textContent = project.name;
  renderFileTree();
  renderTabs();
  const first = project.files.find((f) => f.path === 'index.html') || project.files[0];
  if (first) setActiveFile(first.path);
  await persistProject();
  runPreview();
}

async function promptNewProject(useStarter = true) {
  if (app.editor?.hasUnsavedChanges() &&
      !confirmDialog('You have unsaved changes that will be saved to the current project first. Continue?')) {
    return;
  }
  const name = await modalPrompt('New project', 'Project name:', useStarter ? 'My First Project' : 'New Project');
  if (name === null) return;
  const project = useStarter && !localStorage.getItem('ws:starter-used')
    ? createStarterProject(name || 'My First Project')
    : createEmptyProject(name || 'New Project');
  localStorage.setItem('ws:starter-used', '1');
  await openProject(project);
}

async function renameCurrentProject() {
  if (!app.project) return;
  const name = await modalPrompt('Rename project', 'Project name:', app.project.name);
  if (name === null || !name.trim()) return;
  app.project.name = name.trim();
  $('#project-name-display').textContent = app.project.name;
  $('#status-project').textContent = app.project.name;
  await persistProject();
  toast('Project renamed', 'success');
}

/* ------------------------------------------------------------------ */
/* File operations                                                     */
/* ------------------------------------------------------------------ */

async function createFile(baseDir = '') {
  if (!app.project) {
    toast('Create or open a project first.', 'info');
    return;
  }
  const path = await modalPrompt('New file', 'File path (folders allowed, e.g. pages/about.html):', baseDir ? `${baseDir}/` : '');
  if (path === null || !path.trim()) return;
  const safe = sanitizePath(path.trim());
  if (!safe) {
    toast('Invalid file path.', 'error');
    return;
  }
  const withExt = /\.(html?|css|js|mjs|json|svg|txt|md)$/i.test(safe) ? safe : `${safe}.html`;
  if (app.project.files.some((f) => f.path === withExt)) {
    toast('A file with this path already exists.', 'error');
    return;
  }
  app.project.files.push({ id: `file_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, path: withExt, content: '', type: extOf(withExt) });
  renderFileTree();
  setActiveFile(withExt);
  touchProject();
  toast(`Created ${withExt}`, 'success');
}

async function renamePath(oldPath) {
  const isFile = app.project.files.some((f) => f.path === oldPath);
  const newName = await modalPrompt(`Rename ${isFile ? 'file' : 'folder'}`, 'New name:', oldPath);
  if (newName === null || !newName.trim()) return;
  const target = sanitizePath(newName.trim());
  if (!target) {
    toast('Invalid path.', 'error');
    return;
  }
  if (isFile) {
    const file = app.project.files.find((f) => f.path === oldPath);
    if (app.project.files.some((f) => f.path === target && f !== file)) {
      toast('A file with this path already exists.', 'error');
      return;
    }
    file.path = target;
    app.editor.renameFile(oldPath, target);
  } else {
    for (const file of app.project.files) {
      if (file.path.startsWith(`${oldPath}/`)) {
        const next = target + file.path.slice(oldPath.length);
        app.editor.renameFile(file.path, next);
        file.path = next;
      }
    }
  }
  renderFileTree();
  renderTabs();
  touchProject();
}

async function deletePath(path) {
  const isFile = app.project.files.some((f) => f.path === path);
  let affected = [];
  if (isFile) affected = [path];
  else affected = app.project.files.filter((f) => f.path.startsWith(`${path}/`)).map((f) => f.path);
  if (!confirmDialog(`Delete ${isFile ? `"${path}"` : `folder "${path}" (${affected.length} files)`}? This cannot be undone.`)) return;
  for (const p of affected) app.editor.closeFile(p);
  app.project.files = app.project.files.filter((f) => !affected.includes(f.path));
  renderFileTree();
  renderTabs();
  touchProject();
  toast('Deleted', 'success');
  if (!app.editor.currentFile) {
    const first = app.project.files[0];
    if (first) setActiveFile(first.path);
  }
}

/* ------------------------------------------------------------------ */
/* Modal prompt                                                        */
/* ------------------------------------------------------------------ */

function modalPrompt(title, message, initial = '') {
  return new Promise((resolve) => {
    const overlay = $('#modal-overlay');
    $('#modal-title').textContent = title;
    $('#modal-message').textContent = message;
    const input = $('#modal-input');
    input.style.display = '';
    input.value = initial;
    overlay.classList.add('open');
    setTimeout(() => input.focus(), 30);

    const done = (value) => {
      overlay.classList.remove('open');
      $('#modal-ok').onclick = null;
      $('#modal-cancel').onclick = null;
      overlay.onclick = null;
      resolve(value);
    };
    $('#modal-ok').onclick = () => done(input.value);
    $('#modal-cancel').onclick = () => done(null);
    overlay.onclick = (e) => { if (e.target === overlay) done(null); };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') done(input.value);
      if (e.key === 'Escape') done(null);
    };
  });
}

/* ------------------------------------------------------------------ */
/* Settings UI                                                         */
/* ------------------------------------------------------------------ */

function syncSettingsUI() {
  const s = app.settings;
  $('#setting-app-theme').value = s.appTheme;
  $('#setting-editor-theme').value = s.editorTheme;
  $('#setting-accent').value = s.accent;
  $('#setting-font-size').value = s.fontSize;
  $('#setting-tab-size').value = s.tabSize;
  $('#setting-word-wrap').checked = s.wordWrap;
  $('#setting-indent').value = s.indentUnit;
  $('#setting-font-family').value = s.fontFamily;
  $('#setting-autosave').checked = s.autoSave;
  $('#setting-auto-run').checked = s.autoRun;
  $('#setting-terminal-visible').checked = s.terminalVisible;
}

function onSettingChange(id, apply) {
  $(id).addEventListener('change', (e) => {
    apply(e.target);
    saveSettings(app.settings);
  });
}

function setupSettings() {
  onSettingChange('#setting-app-theme', (el) => applyAppTheme(el.value));
  onSettingChange('#setting-editor-theme', (el) => {
    app.settings.editorTheme = el.value;
    app.editor.applySettings(app.settings);
  });
  onSettingChange('#setting-accent', (el) => applyAccent(el.value));
  onSettingChange('#setting-font-size', (el) => {
    app.settings.fontSize = Math.min(28, Math.max(10, Number(el.value) || 14));
    el.value = app.settings.fontSize;
    app.editor.applySettings(app.settings);
  });
  onSettingChange('#setting-tab-size', (el) => {
    app.settings.tabSize = Number(el.value) || 2;
    app.editor.applySettings(app.settings);
  });
  onSettingChange('#setting-word-wrap', (el) => {
    app.settings.wordWrap = el.checked;
    app.editor.applySettings(app.settings);
  });
  onSettingChange('#setting-indent', (el) => {
    app.settings.indentUnit = el.value;
    app.editor.applySettings(app.settings);
  });
  onSettingChange('#setting-font-family', (el) => {
    app.settings.fontFamily = el.value;
    app.editor.applySettings(app.settings);
  });
  onSettingChange('#setting-autosave', (el) => { app.settings.autoSave = el.checked; });
  onSettingChange('#setting-auto-run', (el) => { app.settings.autoRun = el.checked; });
  onSettingChange('#setting-terminal-visible', (el) => {
    app.settings.terminalVisible = el.checked;
    $('#terminal-panel').classList.toggle('visible', el.checked);
    app.terminal?.fit();
  });

  $('#btn-refresh-storage').addEventListener('click', refreshStorageInfo);
  $('#btn-settings-export').addEventListener('click', exportProjectZip);
  $('#btn-settings-import').addEventListener('click', () => $('#zip-import-input').click());
  $('#btn-clear-data').addEventListener('click', async () => {
    if (!confirmDialog('Delete ALL locally stored projects and files? This cannot be undone.')) return;
    try {
      for (const p of await listProjects()) await deleteProject(p.id);
      app.project = null;
      app.editor?.closeFile(activeFilePath() || '');
      $('#project-name-display').textContent = 'No project';
      $('#status-project').textContent = '';
      renderFileTree();
      renderTabs();
      runPreviewDebounced();
      toast('All local project data cleared', 'success');
    } catch (err) {
      toast(`Failed to clear data: ${err.message}`, 'error');
    }
  });
}

async function refreshStorageInfo() {
  try {
    const info = await estimateStorage();
    $('#storage-info').textContent =
      `${info.projectCount} project(s), ${info.fileCount} file(s), ~${formatBytes(info.bytes)} used locally (IndexedDB)`;
    $('#status-storage').textContent = `~${formatBytes(info.bytes)} stored`;
  } catch {
    $('#storage-info').textContent = 'Storage unavailable';
  }
}

/* ------------------------------------------------------------------ */
/* Terminal bridge                                                     */
/* ------------------------------------------------------------------ */

function terminalBridge() {
  return {
    listProjects: () => listProjects(),
    listFiles: () => (app.project?.files || []).map((f) => ({
      path: f.path,
      size: new Blob([(app.editor?.getContent(f.path) ?? f.content)]).size
    })),
    openFile: (path) => setActiveFile(path, { openIfClosed: true }) !== false,
    runPreview: () => runPreview(),
    togglePreviewMode: () => togglePreviewOnly(),
    setTheme: (name) => setTheme(name),
    resetApp: () => $('#btn-clear-data').click(),
    currentProjectName: () => app.project?.name || null
  };
}

/* ------------------------------------------------------------------ */
/* Layout: split panes, preview-only, mobile tabs                      */
/* ------------------------------------------------------------------ */

let splits = null;

function setupSplits() {
  if (splits) { try { splits.destroy(); } catch { /* noop */ } }
  const workspace = $('#workspace');
  const explorer = $('#explorer-panel');
  const editor = $('#editor-panel');
  const preview = $('#preview-panel');
  const gutter2 = $('#gutter-vertical-2');

  if (app.isMobile) return;

  if (previewOnlyMode) {
    splits = Split(['#editor-panel', '#preview-panel'], {
      sizes: [0, 100], gutterSize: 5, minSize: [0, 200],
      onDrag: () => app.editor && window.dispatchEvent(new Event('resize'))
    });
    gutter2.style.display = 'none';
    return;
  }

  gutter2.style.display = '';
  splits = Split(['#explorer-panel', '#editor-panel', '#preview-panel'], {
    sizes: [18, 47, 35],
    minSize: [150, 250, 250],
    gutterSize: 5,
    onDrag: () => app.terminal?.fit()
  });
  editor.style.flex = '1 1 0';
  explorer.style.flex = 'none';
  preview.style.flex = 'none';
}

let previewOnlyMode = false;
function togglePreviewOnly(force) {
  previewOnlyMode = force !== undefined ? force : !previewOnlyMode;
  $('#btn-preview-only').classList.toggle('active', previewOnlyMode);
  $('#explorer-panel').style.display = previewOnlyMode ? 'none' : '';
  $('#gutter-vertical').style.display = previewOnlyMode ? 'none' : '';
  setupSplits();
  app.terminal?.fit();
  if (previewOnlyMode && app.isMobile) switchMobileTab('preview');
}

function switchMobileTab(name) {
  const map = {
    explorer: '#explorer-panel',
    editor: '#editor-panel',
    preview: '#preview-panel',
    terminal: '#terminal-panel'
  };
  for (const [key, sel] of Object.entries(map)) {
    $(sel).classList.toggle('mobile-active', key === name);
  }
  $('#mobile-tabbar').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mobileTab === name);
  });
  $('#terminal-panel').classList.toggle('visible', name === 'terminal' || app.settings.terminalVisible);
  $('#app').classList.toggle('term-active', name === 'terminal');
  if (name === 'terminal') { requestAnimationFrame(() => app.terminal?.fit()); }
  if (name === 'editor') { window.dispatchEvent(new Event('resize')); }
  if (name === 'preview' && app.project) runPreview();
  mobileTab = name;
}
let mobileTab = 'editor';

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

function isMobileViewport() {
  return window.matchMedia(MOBILE_QUERY).matches;
}

function handleResize() {
  const mobile = isMobileViewport();
  if (mobile !== app.isMobile) {
    app.isMobile = mobile;
    setupSplits();
    if (mobile) switchMobileTab('editor');
    else { $('#app').classList.remove('term-active'); document.querySelectorAll('.mobile-active').forEach((el) => el.classList.remove('mobile-active')); $('#terminal-panel').classList.toggle('visible', !!app.settings.terminalVisible); }
  } else {
    app.terminal?.fit();
  }
}
window.addEventListener('resize', debounce(handleResize, 150));

async function init() {
  /* Icons */
  createIcons({ icons });

  /* Editor */
  app.editor = new Editor($('#editor-host'), {
    settings: app.settings,
    onDocChange: () => {
      renderTabs();
      renderFileTree();
      setSaveStatus('dirty');
      touchProject();
      if (app.settings.autoRun) runPreviewDebounced();
    },
    onDirtyChange: () => {
      renderTabs();
      renderFileTree();
    },
    onCursor: ({ line, col }) => {
      $('#status-cursor').textContent = `Ln ${line}, Col ${col}`;
    }
  });

  /* Preview */
  app.preview = new Preview($('#preview-frame'), {
    onError: (data) => appendConsoleLine('error', data.line ? `${data.message} (line ${data.line})` : data.message),
    onConsole: (level, text) => appendConsoleLine(level, text)
  });

  /* Terminal */
  app.terminal = new TerminalPanel($('#terminal-host'), terminalBridge());

  /* Split layout */
  setupSplits();

  /* Settings UI */
  setupSettings();
  syncSettingsUI();
  applyAppTheme(app.settings.appTheme);
  applyAccent(app.settings.accent);
  await refreshStorageInfo();

  /* Header controls */
  $('#btn-run').addEventListener('click', runPreview);
  $('#btn-preview-refresh').addEventListener('click', () => {
    clearConsole();
    app.preview.refresh();
    appendConsoleLine('info', 'Preview refreshed');
  });
  $('#btn-preview-desktop').addEventListener('click', () => {
    const frame = $('#preview-frame');
    frame.className = 'device-desktop';
    $('#btn-preview-desktop').classList.add('active');
    $('#btn-preview-mobile').classList.remove('active');
  });
  $('#btn-preview-mobile').addEventListener('click', () => {
    const frame = $('#preview-frame');
    frame.className = 'device-mobile';
    $('#btn-preview-mobile').classList.add('active');
    $('#btn-preview-desktop').classList.remove('active');
  });
  $('#btn-preview-only').addEventListener('click', () => togglePreviewOnly());
  $('#btn-console').addEventListener('click', () => {
    const out = $('#console-output');
    out.classList.toggle('visible');
    $('#btn-console').classList.toggle('active', out.classList.contains('visible'));
  });

  $('#btn-new-project').addEventListener('click', () => promptNewProject());
  $('#project-name-display').addEventListener('click', renameCurrentProject);
  $('#btn-export').addEventListener('click', exportProjectZip);
  $('#btn-import').addEventListener('click', () => $('#zip-import-input').click());
  $('#zip-import-input').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) importProjectZip(file);
    e.target.value = '';
  });

  $('#btn-new-file').addEventListener('click', () => createFile());
  $('#btn-new-folder').addEventListener('click', () => createFile());
  $('#file-tree').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    e.stopPropagation();
    const path = btn.dataset.path;
    if (btn.dataset.action === 'rename') renamePath(path);
    else if (btn.dataset.action === 'delete') deletePath(path);
    else if (btn.dataset.action === 'new-file-in') createFile(path);
  });

  $('#btn-terminal').addEventListener('click', () => {
    app.settings.terminalVisible = true;
    saveSettings(app.settings);
    $('#terminal-panel').classList.add('visible');
    if (app.isMobile) { switchMobileTab('terminal'); return; }
    $('#terminal-panel').classList.add('mobile-active');
    app.terminal.fit();
    app.terminal.focus();
  });
  $('#btn-terminal-close').addEventListener('click', () => {
    $('#terminal-panel').classList.remove('visible', 'mobile-active');
    app.settings.terminalVisible = false;
    saveSettings(app.settings);
    syncSettingsUI();
    if (app.isMobile) switchMobileTab('editor');
  });

  /* Settings drawer */
  const drawer = $('#settings-drawer');
  const overlay = $('#settings-overlay');
  const openSettings = () => {
    drawer.classList.add('open');
    overlay.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
  };
  const closeSettings = () => {
    drawer.classList.remove('open');
    overlay.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
  };
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-settings-close').addEventListener('click', closeSettings);
  overlay.addEventListener('click', closeSettings);

  /* Mobile tab bar */
  $('#mobile-tabbar').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mobile-tab]');
    if (!btn) return;
    if (btn.dataset.mobileTab === 'terminal') {
      $('#terminal-panel').classList.add('visible');
      app.terminal?.fit();
    }
    switchMobileTab(btn.dataset.mobileTab);
  });

  /* Keyboard shortcuts */
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key === 's') {
      e.preventDefault();
      if (app.project) { persistProject(); app.editor?.markSaved(activeFilePath() || ''); renderTabs(); renderFileTree(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runPreview();
    } else if (e.key === 'b') {
      e.preventDefault();
      $('#btn-terminal').click();
    } else if (e.key === ',') {
      e.preventDefault();
      openSettings();
    }
  });

  /* Warn before leaving with unsaved changes */
  window.addEventListener('beforeunload', (e) => {
    if (app.editor?.hasUnsavedChanges()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /* Restore last project or create the starter one */
  try {
    let project = null;
    if (app.settings.lastOpenedProject) {
      project = await loadProject(app.settings.lastOpenedProject);
    }
    if (!project) {
      const all = await listProjects();
      project = all[0] || null;
    }
    if (project) {
      await openProject(project);
    } else {
      // First run: silently create the starter project (no blocking modal).
      const starter = createStarterProject('My First Project');
      localStorage.setItem('ws:starter-used', '1');
      await openProject(starter);
    }
  } catch (err) {
    console.error(err);
    toast(`Could not load saved projects: ${err.message}`, 'error', 6000);
    const fallback = createStarterProject('My First Project');
    await openProject(fallback);
  }

  refreshIcons();
  setSaveStatus('saved');
  setupMobileExtras();
  if (app.isMobile) switchMobileTab('editor');
}

/* Mobile-only helpers: keyboard-aware height + code symbol bar */
function setupMobileExtras() {
  const vv = window.visualViewport;
  const setVh = () => {
    document.documentElement.style.setProperty('--vvh', (vv ? vv.height : window.innerHeight) + 'px');
    if (vv) window.scrollTo(0, 0);
  };
  setVh();
  vv?.addEventListener('resize', () => { setVh(); app.terminal?.fit(); });

  const keys = [['Tab', '\t'], ['<', '<'], ['>', '>'], ['/', '/'], ['{', '{'], ['}', '}'], ['(', '('], [')', ')'],
    ['[', '['], [']', ']'], ['"', '"'], ["'", "'"], ['=', '='], [';', ';'], [':', ':'], ['#', '#'], ['↶', 'undo'], ['↷', 'redo']];
  const bar = $('#mobile-keys');
  bar.innerHTML = keys.map(([l, v]) => `<button type="button" data-k="${escapeHtml(v)}">${escapeHtml(l)}</button>`).join('');
  bar.addEventListener('pointerdown', (e) => e.preventDefault()); // keep editor focus/keyboard
  bar.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-k]');
    const view = app.editor?.view;
    if (!b || !view) return;
    const k = b.dataset.k;
    if (k === 'undo' || k === 'redo') {
      const { undo, redo } = await import('@codemirror/commands');
      (k === 'undo' ? undo : redo)(view);
    } else {
      const { from, to } = view.state.selection.main;
      view.dispatch({ changes: { from, to, insert: k }, selection: { anchor: from + k.length }, scrollIntoView: true, userEvent: 'input' });
    }
    view.focus();
  });
}

// Render icons that were added after initial load (tree rows, tabs).
window.addEventListener('DOMContentLoaded', refreshIcons);

init();
