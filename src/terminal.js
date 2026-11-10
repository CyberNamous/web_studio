/**
 * terminal.js — integrated terminal using @xterm/xterm with a custom,
 * browser-side command interpreter. This is NOT a shell and must not be
 * presented as one: only the whitelisted commands below run, and they
 * interact with Web Studio's own modules.
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { APP_VERSION } from './app.js';

const HELP_TEXT = [
  'Web Studio terminal — browser-side command interpreter (not a Linux shell).',
  '',
  'Available commands:',
  '  help              Show this help',
  '  clear             Clear the terminal',
  '  version           Show Web Studio version',
  '  about             About Web Studio',
  '  projects          List saved projects',
  '  files [dir]       List files in the current project',
  '  open <path>       Open a file in the editor',
  '  run               Rebuild and run the live preview',
  '  preview           Toggle preview-only mode',
  '  theme <name>      Set app theme (dark, light, midnight, dracula, nord, monokai, rosepine, solarized-dark)',
  '  reset             Reset Web Studio to factory defaults (asks confirmation in UI)',
  ''
].join('\r\n');

export class TerminalPanel {
  /**
   * @param {HTMLElement} container
   * @param {object} bridge functions exposed by the app:
   *   listProjects(), listFiles(), openFile(path), runPreview(), togglePreviewMode(),
   *   setTheme(name), resetApp(), currentProjectName()
   */
  constructor(container, bridge = {}) {
    this.bridge = bridge;
    this.container = container;
    this.term = new Terminal({
      fontFamily: "ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace",
      fontSize: 12.5,
      cursorBlink: true,
      convertEol: true,
      theme: {
        background: '#11151c',
        foreground: '#d7dae0',
        cursor: '#4f8cff',
        selectionBackground: '#31415f'
      }
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(container);
    this.fitAddon.fit();

    this.term.onData((data) => this._handleInput(data));
    this._buffer = '';
    this.greet();
  }

  greet() {
    this.term.writeln(`Web Studio v${APP_VERSION} — type "help" for available commands.`);
    this.term.writeln('');
    this.prompt();
  }

  prompt() {
    const proj = this.bridge.currentProjectName?.() || 'no project';
    this.term.write(`\x1b[38;5;75mweb-studio\x1b[0m:\x1b[38;5;114m${proj}\x1b[0m$ `);
  }

  _handleInput(data) {
    if (data === '\r') {
      const line = this._buffer.trim();
      this._buffer = '';
      this.term.writeln('');
      if (line) this.execute(line);
      this.prompt();
      return;
    }
    if (data === '\u007f') { // backspace
      if (this._buffer.length > 0) {
        this._buffer = this._buffer.slice(0, -1);
        this.term.write('\b \b');
      }
      return;
    }
    if (data === '\u0003') { // Ctrl+C
      this._buffer = '';
      this.term.writeln('^C');
      this.prompt();
      return;
    }
    if (data >= ' ' && data <= '~') {
      this._buffer += data;
      this.term.write(data);
    }
  }

  execute(line) {
    const [cmd, ...args] = line.split(/\s+/);
    const arg = args.join(' ');
    switch (cmd.toLowerCase()) {
      case 'help': this.term.writeln(HELP_TEXT); break;
      case 'clear': this.term.clear(); break;
      case 'version': this.term.writeln(`Web Studio v${APP_VERSION}`); break;
      case 'about':
        this.term.writeln('Web Studio — a lightweight, local-first browser IDE for HTML, CSS and JS.');
        this.term.writeln('No accounts, no database, no server-side code execution.');
        break;
      case 'projects': this._cmdProjects(); break;
      case 'files': this._cmdFiles(arg); break;
      case 'open': this._cmdOpen(arg); break;
      case 'run': this.bridge.runPreview?.(); this.term.writeln('Preview updated.'); break;
      case 'preview': this.bridge.togglePreviewMode?.(); this.term.writeln('Toggled preview mode.'); break;
      case 'theme': this._cmdTheme(arg); break;
      case 'reset': this.bridge.resetApp?.(); this.term.writeln('Reset requested — confirm in the dialog.'); break;
      default:
        this.term.writeln(`\x1b[38;5;203mUnknown command: ${cmd}\x1b[0m — type "help" to see available commands.`);
    }
  }

  async _cmdProjects() {
    try {
      const projects = (await this.bridge.listProjects?.()) || [];
      if (projects.length === 0) {
        this.term.writeln('No saved projects.');
        return;
      }
      for (const p of projects) {
        this.term.writeln(`${p.name}  (${(p.files || []).length} files, updated ${new Date(p.updatedAt).toLocaleString()})`);
      }
    } catch (err) {
      this.term.writeln(`Error listing projects: ${err.message}`);
    }
  }

  async _cmdFiles(dirFilter) {
    try {
      const files = (await this.bridge.listFiles?.()) || [];
      const filtered = dirFilter ? files.filter((f) => f.path.startsWith(dirFilter)) : files;
      if (filtered.length === 0) {
        this.term.writeln(dirFilter ? `No files under "${dirFilter}".` : 'No files in this project.');
        return;
      }
      for (const f of filtered) this.term.writeln(`${f.path}  ${f.size}B`);
    } catch (err) {
      this.term.writeln(`Error listing files: ${err.message}`);
    }
  }

  _cmdOpen(path) {
    if (!path) {
      this.term.writeln('Usage: open <path>   e.g. open index.html');
      return;
    }
    const ok = this.bridge.openFile?.(path);
    this.term.writeln(ok ? `Opening ${path}…` : `File not found: ${path}`);
  }

  _cmdTheme(name) {
    const valid = ['dark', 'light', 'midnight', 'dracula', 'nord', 'monokai', 'rosepine', 'solarized-dark'];
    if (!name) {
      this.term.writeln(`Usage: theme <name>. Valid themes: ${valid.join(', ')}`);
      return;
    }
    if (!valid.includes(name)) {
      this.term.writeln(`Unknown theme "${name}". Valid themes: ${valid.join(', ')}`);
      return;
    }
    this.bridge.setTheme?.(name);
    this.term.writeln(`App theme set to ${name}.`);
  }

  fit() {
    try { this.fitAddon.fit(); } catch { /* container hidden */ }
  }

  focus() {
    this.term.focus();
  }
}
