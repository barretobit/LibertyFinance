/* ===== Cross-browser local file storage =====
 *
 * Two storage modes:
 *   - Folder mode  ("dir"):     File System Access API (Chrome/Edge/Opera).
 *                               User picks a data folder once; real .json files
 *                               are read/written there, plus a Backups/ subfolder.
 *   - File mode    ("classic"): Works in every browser (Firefox/Safari/...).
 *                               User opens a .json profile; edits are kept in an
 *                               IndexedDB mirror; "SAVE FILE" downloads the file
 *                               so the user keeps a real copy on disk.
 *
 * Both adapters expose the same interface: connect, list, read, write, remove,
 * backup.
 */

const Storage = (() => {
  const IDB_NAME = 'liberty-finance-storage';
  const IDB_STORE = 'kv';

  const MODE_KEY = 'liberty-finance-mode';
  const DIR_HANDLE_KEY = 'dir-handle';
  const LAST_FILE_KEY = 'liberty-finance-last-file';
  const CLASSIC_FILES_KEY = 'classic-files';
  const CLASSIC_FILE_PREFIX = 'classic-file:';
  const CLASSIC_BACKUPS_PREFIX = 'classic-backups:';
  const PENDING_OPEN_KEY = 'classic-pending-open';
  const MAX_BACKUPS = 30;

  let adapter = null;

  // ==================== IndexedDB helpers ====================

  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbDel(key) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ==================== Shared helpers ====================

  function timestamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function download(name, content) {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function openFileDialog(accept) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept || '.json,application/json';
      input.style.display = 'none';
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) { resolve(null); return; }
        const content = await file.text();
        resolve({ name: file.name, content });
      };
      document.body.appendChild(input);
      input.click();
      document.body.removeChild(input);
    });
  }

  function normalizeFileName(name) {
    let n = String(name || '').trim();
    n = n.replace(/\.json$/i, '');
    n = n.toLowerCase().replace(/[^a-z0-9 ._-]/g, '').trim();
    if (!n) return null;
    return n + '.json';
  }

  // ==================== Folder mode (File System Access API) ====================

  const DirectoryAdapter = {
    kind: 'dir',
    handle: null,

    async connect() {
      if (this.handle) return this.handle;

      const saved = await idbGet(DIR_HANDLE_KEY);
      if (saved) {
        try {
          let perm = await saved.queryPermission({ mode: 'readwrite' });
          if (perm === 'prompt') {
            try { perm = await saved.requestPermission({ mode: 'readwrite' }); } catch (e) { /* ignored */ }
          }
          if (perm === 'granted') { this.handle = saved; return saved; }
        } catch (e) { /* fall through to a fresh pick */ }
      }

      if (!window.showDirectoryPicker) throw new Error('FOLDER MODE NOT SUPPORTED IN THIS BROWSER');
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await idbSet(DIR_HANDLE_KEY, handle);
      this.handle = handle;
      return handle;
    },

    async _fileHandle(name, create) {
      const dir = await this.connect();
      try {
        return await dir.getFileHandle(name, create ? { create: true } : undefined);
      } catch (e) {
        if (e && e.name === 'NotFoundError') return null;
        throw e;
      }
    },

    // Force a fresh picker so the user can switch to a different folder.
    // The previous handle is only replaced after the new pick succeeds,
    // so cancelling keeps the current connection intact.
    async pickNew() {
      if (!window.showDirectoryPicker) throw new Error('FOLDER MODE NOT SUPPORTED IN THIS BROWSER');
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await idbSet(DIR_HANDLE_KEY, handle);
      this.handle = handle;
      return handle;
    },

    async list() {
      const dir = await this.connect();
      const files = [];
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== 'file') continue;
        const lower = name.toLowerCase();
        if (!lower.endsWith('.json')) continue;
        if (lower === 'market.json' || lower === 'shell.settings.json') continue;
        const fh = await handle.getFile();
        files.push({ name, size: fh.size, modified: fh.lastModified });
      }
      files.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
      return files;
    },

    async read(name) {
      const fh = await this._fileHandle(name, false);
      if (!fh) return null;
      const file = await fh.getFile();
      return await file.text();
    },

    async write(name, json) {
      const fh = await this._fileHandle(name, true);
      const w = await fh.createWritable();
      await w.write(json);
      await w.close();
    },

    async remove(name) {
      const dir = await this.connect();
      await dir.removeEntry(name);
    },

    async backup(name, json) {
      const dir = await this.connect();
      let content = json;
      const existing = await this.read(name);
      if (existing != null) content = existing;

      let backupsDir;
      try {
        backupsDir = await dir.getDirectoryHandle('Backups', { create: true });
      } catch (e) { return; }
      const stamp = timestamp();
      const fh = await backupsDir.getFileHandle(name.replace(/\.json$/i, '') + '-' + stamp + '.json', { create: true });
      const w = await fh.createWritable();
      await w.write(content);
      await w.close();

      const entries = [];
      for await (const [n, h] of backupsDir.entries()) {
        if (h.kind === 'file' && n.toLowerCase().endsWith('.json')) entries.push(n);
      }
      entries.sort();
      while (entries.length > MAX_BACKUPS) {
        const old = entries.shift();
        try { await backupsDir.removeEntry(old); } catch (e) { /* ignored */ }
      }
    }
  };

  // ==================== File mode (works everywhere) ====================

  const ClassicAdapter = {
    kind: 'classic',

    async connect() { return true; },

    async list() {
      const names = (await idbGet(CLASSIC_FILES_KEY)) || [];
      const files = [];
      for (const name of names) {
        const meta = await idbGet(CLASSIC_FILE_PREFIX + 'meta:' + name);
        files.push({ name, size: meta ? meta.size : 0, modified: meta ? meta.modified : 0 });
      }
      files.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
      return files;
    },

    async read(name) {
      return (await idbGet(CLASSIC_FILE_PREFIX + name)) || null;
    },

    async write(name, json) {
      await idbSet(CLASSIC_FILE_PREFIX + name, json);
      await idbSet(CLASSIC_FILE_PREFIX + 'meta:' + name, { size: (json || '').length, modified: Date.now() });
      const names = (await idbGet(CLASSIC_FILES_KEY)) || [];
      if (!names.includes(name)) {
        names.push(name);
        await idbSet(CLASSIC_FILES_KEY, names);
      }
    },

    async remove(name) {
      await idbDel(CLASSIC_FILE_PREFIX + name);
      await idbDel(CLASSIC_FILE_PREFIX + 'meta:' + name);
      const names = ((await idbGet(CLASSIC_FILES_KEY)) || []).filter(n => n !== name);
      await idbSet(CLASSIC_FILES_KEY, names);
    },

    async backup(name, json) {
      const list = (await idbGet(CLASSIC_BACKUPS_PREFIX + name)) || [];
      list.push({ at: timestamp(), json });
      while (list.length > MAX_BACKUPS) list.shift();
      await idbSet(CLASSIC_BACKUPS_PREFIX + name, list);
    }
  };

  // ==================== Mode selection ====================

  async function get() {
    if (adapter) return adapter;
    let mode = localStorage.getItem(MODE_KEY);
    if (!mode) mode = window.showDirectoryPicker ? 'dir' : 'classic';
    adapter = mode === 'dir' ? DirectoryAdapter : ClassicAdapter;
    return adapter;
  }

  async function setMode(mode) {
    if (mode !== 'dir' && mode !== 'classic') throw new Error('Unknown storage mode: ' + mode);
    localStorage.setItem(MODE_KEY, mode);
    adapter = mode === 'dir' ? DirectoryAdapter : ClassicAdapter;
    return adapter;
  }

  // Pass an opened file through navigation (classic mode: index -> app)
  function setPendingOpen(entry) {
    try { sessionStorage.setItem(PENDING_OPEN_KEY, JSON.stringify(entry)); } catch (e) { /* ignored */ }
  }

  function consumePendingOpen() {
    try {
      const raw = sessionStorage.getItem(PENDING_OPEN_KEY);
      sessionStorage.removeItem(PENDING_OPEN_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  async function pickNewFolder() {
    // Opening a folder is always a deliberate, gesture-driven act: force the
    // picker even if a handle from a previous session exists.
    const a = await setMode('dir');
    return a.pickNew();
  }

  return {
    get,
    setMode,
    supportsDirectory: () => !!window.showDirectoryPicker,
    currentKind: () => (adapter ? adapter.kind : null),
    pickNewFolder,
    idbGet,
    idbSet,
    idbDel,
    download,
    openFileDialog,
    normalizeFileName,
    setPendingOpen,
    consumePendingOpen,
    LAST_FILE_KEY
  };
})();
