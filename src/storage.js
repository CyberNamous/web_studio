/**
 * storage.js — local persistence layer.
 *
 * - Projects and files live in IndexedDB via idb-keyval.
 * - Lightweight app preferences live in localStorage.
 * - No accounts, no cloud sync.
 */
import { get, set, del, keys } from 'idb-keyval';
import { uid, extOf, isSupportedFile } from './utils.js';

const PROJECT_PREFIX = 'ws:project:';
const SETTINGS_KEY = 'ws:settings';

/* ------------------------------------------------------------------ */
/* Settings (localStorage)                                             */
/* ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS = {
  appTheme: 'dark',          // 'system' | 'dark' | 'light' | 'midnight' | 'dracula' | 'nord' | 'monokai' | 'rosepine' | 'solarized-dark'
  editorTheme: 'oneDark',    // see EDITOR_THEMES in editor.js
  accent: '#4f8cff',
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  tabSize: 2,
  wordWrap: true,
  indentUnit: 'spaces',      // 'spaces' | 'tabs'
  autoSave: true,
  autoRun: true,
  terminalVisible: false,
  lastOpenedProject: null
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    // Merge so newly-added settings keys get defaults.
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (err) {
    console.warn('[web-studio] settings unreadable, using defaults', err);
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch (err) {
    console.error('[web-studio] failed to persist settings', err);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Projects (IndexedDB)                                                */
/* ------------------------------------------------------------------ */

function fileRecord(path, content = '') {
  return { id: uid('file'), path, content, type: extOf(path) || 'txt' };
}

/** Default starter project shown to first-time users. */
export function createStarterProject(name = 'My First Project') {
  return {
    id: uid('proj'),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    files: [
      fileRecord(
        'index.html',
        `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>My First Project</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <main class="card">
    <h1>Hello, Web Studio 👋</h1>
    <p>Edit <strong>index.html</strong>, <strong>style.css</strong> or <strong>script.js</strong> — the preview updates automatically.</p>
    <button id="counter" type="button">Clicked 0 times</button>
  </main>
  <script src="script.js"></script>
</body>
</html>
`
      ),
      fileRecord(
        'style.css',
        `* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font-family: system-ui, -apple-system, sans-serif;
  background: linear-gradient(135deg, #0f172a, #1e293b);
  color: #e2e8f0;
}

.card {
  text-align: center;
  padding: 2.5rem 3rem;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.06);
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
}

h1 { margin-top: 0; }

button {
  margin-top: 1rem;
  padding: 0.6rem 1.4rem;
  border: none;
  border-radius: 8px;
  background: #4f8cff;
  color: #fff;
  font-size: 1rem;
  cursor: pointer;
}

button:hover { filter: brightness(1.1); }
`
      ),
      fileRecord(
        'script.js',
        `let count = 0;
const button = document.getElementById('counter');

button?.addEventListener('click', () => {
  count += 1;
  button.textContent = \`Clicked \${count} time\${count === 1 ? '' : 's'}\`;
});
`
      )
    ]
  };
}

/** Empty project with the required initial template. */
export function createEmptyProject(name = 'New Project') {
  const project = {
    id: uid('proj'),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    files: [
      fileRecord(
        'index.html',
        `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${name}</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <h1>${name}</h1>
  <script src="script.js"></script>
</body>
</html>
`
      ),
      fileRecord('style.css', `body {\n  font-family: system-ui, sans-serif;\n  margin: 2rem;\n}\n`),
      fileRecord('script.js', `console.log('Hello from ${name}');\n`)
    ]
  };
  return project;
}

export async function saveProject(project) {
  if (!project || !project.id) throw new Error('Invalid project');
  project.updatedAt = Date.now();
  project.files = project.files.filter((f) => f && typeof f.path === 'string');
  await set(PROJECT_PREFIX + project.id, project);
  return project;
}

export async function loadProject(id) {
  return (await get(PROJECT_PREFIX + id)) || null;
}

export async function deleteProject(id) {
  await del(PROJECT_PREFIX + id);
}

export async function listProjects() {
  const allKeys = await keys();
  const projectKeys = allKeys.filter((k) => typeof k === 'string' && k.startsWith(PROJECT_PREFIX));
  const projects = [];
  for (const k of projectKeys) {
    try {
      const p = await get(k);
      if (p && p.id) projects.push(p);
    } catch (err) {
      console.warn('[web-studio] skipping unreadable project', k, err);
    }
  }
  projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return projects;
}

/** Rough estimate of bytes used by projects (for storage info UI). */
export async function estimateStorage() {
  const projects = await listProjects();
  let bytes = 0;
  let fileCount = 0;
  for (const p of projects) {
    fileCount += p.files?.length || 0;
    bytes += JSON.stringify(p).length * 2; // UTF-16 approximation
  }
  return { projectCount: projects.length, fileCount, bytes };
}

export { isSupportedFile };
