/**
 * editor.js — CodeMirror 6 editor module.
 *
 * A single CodeMirror instance is created once and reconfigured when the
 * active file, language or preferences change (never re-created), which keeps
 * resizing and tab switching cheap.
 */
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, drawSelection, dropCursor, rectangularSelection,
  crosshairCursor } from '@codemirror/view';
import { EditorState, Compartment, EditorSelection } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { indentOnInput, bracketMatching, foldGutter, foldKeymap, indentUnit } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { lintKeymap } from '@codemirror/lint';
import { html } from '@codemirror/lang-html';
import { css as cssLang } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';

import {
  dracula, monokai, nord, solarizedDark, githubLight, vscodeDark, vscodeLight
} from '@uiw/codemirror-themes-all';

/** Map of editor theme name -> CodeMirror theme extension. */
export const EDITOR_THEMES = {
  oneDark: { label: 'One Dark', ext: oneDark },
  dracula: { label: 'Dracula', ext: dracula },
  monokai: { label: 'Monokai', ext: monokai },
  nord: { label: 'Nord', ext: nord },
  solarizedDark: { label: 'Solarized Dark', ext: solarizedDark },
  githubLight: { label: 'GitHub Light', ext: githubLight },
  vscodeDark: { label: 'VS Code Dark', ext: vscodeDark },
  vscodeLight: { label: 'VS Code Light', ext: vscodeLight }
};

export const DEFAULT_EDITOR_THEME = 'oneDark';

const langCompartment = new Compartment();
const themeCompartment = new Compartment();
const prefsCompartment = new Compartment();

/** GitHub Light / VS Code Light are light editor themes. */
export function editorThemeIsDark(key) {
  return !['githubLight', 'vscodeLight'].includes(key);
}

function languageFor(path = '') {
  const ext = path.toLowerCase().split('.').pop();
  if (ext === 'html' || ext === 'htm' || ext === 'svg') return html({ autoCloseTags: true });
  if (ext === 'css') return cssLang();
  if (ext === 'js' || ext === 'mjs' || ext === 'json') {
    return javascript({ json: ext === 'json' });
  }
  return html(); // closest default for plain text
}

export class Editor {
  /**
   * @param {HTMLElement} parent container element
   * @param {object} opts { settings, onDocChange(fileRecord, doc), onDirtyChange(bool), onCursor({line,col}) }
   */
  constructor(parent, opts = {}) {
    this.opts = opts;
    this.settings = opts.settings;
    this.currentFile = null;      // file record currently open
    this.openTabs = new Map();    // path -> { file, docString, dirty }
    this.dirty = false;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) this._handleDocChange(update);
      if (update.selectionSet || update.focusChanged) this._emitSelection(update);
    });

    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: '',
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...completionKeymap,
            ...lintKeymap,
            indentWithTab
          ]),
          langCompartment.of(this._langExt('')),
          themeCompartment.of(this._themeExt()),
          prefsCompartment.of(this._prefsExt()),
          updateListener
        ]
      })
    });
  }

  _langExt(path) {
    return languageFor(path);
  }

  _themeExt() {
    const key = this.settings?.editorTheme || DEFAULT_EDITOR_THEME;
    const theme = EDITOR_THEMES[key] || EDITOR_THEMES[DEFAULT_EDITOR_THEME];
    return theme.ext;
  }

  _prefsExt() {
    const s = this.settings || {};
    const exts = [indentUnit.of(s.indentUnit === 'tabs' ? '\t' : '  ')];
    exts.push(EditorView.theme({
      '&': { fontSize: `${s.fontSize || 14}px` },
      '.cm-content': { fontFamily: s.fontFamily || 'monospace' },
      '.cm-gutters': { fontFamily: s.fontFamily || 'monospace' }
    }));
    exts.push(s.wordWrap ? EditorView.lineWrapping : []);
    return exts;
  }

  _handleDocChange(update) {
    if (!this.currentFile) return;
    const docString = update.state.doc.toString();
    const entry = this.openTabs.get(this.currentFile.path);
    const wasDirty = entry ? entry.dirty : false;
    if (entry) {
      entry.docString = docString;
      entry.dirty = true;
    }
    this.dirty = true;
    this.opts.onDocChange?.(this.currentFile, docString);
    if (!wasDirty) this.opts.onDirtyChange?.(true);
  }

  _emitSelection(update) {
    const sel = update.state.selection.main;
    const line = update.state.doc.lineAt(sel.head);
    this.opts.onCursor?.({ line: line.number, col: sel.head - line.from + 1 });
  }

  /** Open a file record { path, content }. Switches doc without re-creating the editor. */
  openFile(fileRecord) {
    if (!fileRecord) return;
    this._syncCurrentFromView();

    let entry = this.openTabs.get(fileRecord.path);
    if (!entry) {
      entry = { file: fileRecord, docString: fileRecord.content, dirty: false };
      this.openTabs.set(fileRecord.path, entry);
    } else {
      entry.file = fileRecord; // refresh reference
    }

    this.currentFile = fileRecord;
    const state = this.view.state;
    this.view.dispatch({
      effects: langCompartment.reconfigure(languageFor(fileRecord.path)),
      changes: { from: 0, to: state.doc.length, insert: entry.docString }
    });
    this.view.dispatch({ selection: EditorSelection.cursor(0), scrollIntoView: true });
    this.dirty = entry.dirty;
    this.opts.onDirtyChange?.(entry.dirty);
  }

  /** Write the live view doc back into the tab entry. */
  _syncCurrentFromView() {
    if (!this.currentFile) return;
    const entry = this.openTabs.get(this.currentFile.path);
    if (entry) entry.docString = this.view.state.doc.toString();
  }

  /** Latest content for a file path (live if currently open). */
  getContent(path) {
    if (this.currentFile && this.currentFile.path === path) {
      this._syncCurrentFromView();
      return this.view.state.doc.toString();
    }
    return this.openTabs.get(path)?.docString ?? null;
  }

  /** Mark a path saved (after autosave persisted it). */
  markSaved(path) {
    const entry = this.openTabs.get(path);
    if (entry) entry.dirty = false;
    if (this.currentFile && this.currentFile.path === path) {
      this.dirty = false;
      this.opts.onDirtyChange?.(false);
    }
  }

  /** File was deleted/renamed externally. */
  closeFile(path) {
    const entry = this.openTabs.get(path);
    if (!entry) return;
    this.openTabs.delete(path);
    if (this.currentFile && this.currentFile.path === path) {
      this.currentFile = null;
      this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: '' } });
    }
  }

  renameFile(oldPath, newPath) {
    const entry = this.openTabs.get(oldPath);
    if (!entry) return;
    this.openTabs.delete(oldPath);
    this.openTabs.set(newPath, entry);
    if (this.currentFile && this.currentFile.path === oldPath) {
      this.currentFile.path = newPath;
      this.view.dispatch({
        effects: langCompartment.reconfigure(languageFor(newPath))
      });
    }
  }

  hasUnsavedChanges() {
    this._syncCurrentFromView();
    for (const entry of this.openTabs.values()) if (entry.dirty) return true;
    return false;
  }

  dirtyPaths() {
    this._syncCurrentFromView();
    return [...this.openTabs.entries()].filter(([, e]) => e.dirty).map(([p]) => p);
  }

  /** Update editor preferences (theme / font / etc.) without recreating. */
  applySettings(settings) {
    this.settings = settings;
    this.view.dispatch({
      effects: [
        themeCompartment.reconfigure(this._themeExt()),
        prefsCompartment.reconfigure(this._prefsExt())
      ]
    });
  }

  focus() {
    this.view.focus();
  }

  destroy() {
    this.view?.destroy();
  }
}
