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
  const INDEXED_DB_NAME = 'liberty-finance-storage';
  const INDEXED_DB_STORE = 'kv';

  const MODE_KEY = 'liberty-finance-mode';
  const DIRECTORY_HANDLE_KEY = 'dir-handle';
  const LAST_FILE_KEY = 'liberty-finance-last-file';
  const CLASSIC_FILES_KEY = 'classic-files';
  const CLASSIC_FILE_PREFIX = 'classic-file:';
  const CLASSIC_BACKUPS_PREFIX = 'classic-backups:';
  const PENDING_OPEN_KEY = 'classic-pending-open';
  const OPEN_ERROR_KEY = 'liberty-finance-open-error';
  const MAX_BACKUPS = 30;

  // Shared data files written by features (rates, market cache, randata cache).
  // They are not user profiles and must never appear in the profile picker.
  const SharedFiles = new Set(['market.json', 'randata.json', 'shell.settings.json']);

  let adapter = null;

  // ==================== IndexedDB helpers ====================

  function openIndexedDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(INDEXED_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(INDEXED_DB_STORE)) database.createObjectStore(INDEXED_DB_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function indexedDbGet(key) {
    const database = await openIndexedDb();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(INDEXED_DB_STORE, 'readonly');
      const request = transaction.objectStore(INDEXED_DB_STORE).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function indexedDbSet(key, value) {
    const database = await openIndexedDb();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(INDEXED_DB_STORE, 'readwrite');
      transaction.objectStore(INDEXED_DB_STORE).put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async function indexedDbKeys() {
    const database = await openIndexedDb();
    return new Promise((resolve, reject) => {
      const request = database.transaction(INDEXED_DB_STORE, 'readonly').objectStore(INDEXED_DB_STORE).getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function indexedDbDelete(key) {
    const database = await openIndexedDb();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(INDEXED_DB_STORE, 'readwrite');
      transaction.objectStore(INDEXED_DB_STORE).delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  // ==================== Shared helpers ====================

  function timestamp() {
    const now = new Date();
    const padTwoDigits = number => String(number).padStart(2, '0');
    return '' + now.getFullYear() + padTwoDigits(now.getMonth() + 1) + padTwoDigits(now.getDate()) +
      '-' + padTwoDigits(now.getHours()) + padTwoDigits(now.getMinutes()) + padTwoDigits(now.getSeconds());
  }

  function download(name, content) {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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

  const PERMISSION_TIMEOUT_MS = 3000;

  // Resolve with the promise's value, or with fallback if it has not settled in time.
  function settleWithin(promise, milliseconds, fallback) {
    return Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(fallback), milliseconds))]);
  }

  function normalizeFileName(name) {
    let normalized = String(name || '').trim();
    normalized = normalized.replace(/\.json$/i, '');
    normalized = normalized.toLowerCase().replace(/[^a-z0-9 ._-]/g, '').trim();
    if (!normalized) return null;
    return normalized + '.json';
  }

  // ==================== Folder mode (File System Access API) ====================

  const DirectoryAdapter = {
    kind: 'dir',
    handle: null,

    async connect() {
      if (this.handle) return this.handle;

      const saved = await indexedDbGet(DIRECTORY_HANDLE_KEY);
      if (saved) {
        try {
          // Chrome can leave permission checks on a saved handle pending forever,
          // which would block the landing page from ever showing its buttons.
          let permission = await settleWithin(saved.queryPermission({ mode: 'readwrite' }), PERMISSION_TIMEOUT_MS, 'denied');
          if (permission === 'prompt') {
            try { permission = await settleWithin(saved.requestPermission({ mode: 'readwrite' }), PERMISSION_TIMEOUT_MS, 'denied'); } catch (error) { /* ignored */ }
          }
          if (permission === 'granted') { this.handle = saved; return saved; }
        } catch (error) { /* fall through to a fresh pick */ }
      }

      if (!window.showDirectoryPicker) throw new Error('FOLDER MODE NOT SUPPORTED IN THIS BROWSER');
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await indexedDbSet(DIRECTORY_HANDLE_KEY, handle);
      this.handle = handle;
      return handle;
    },

    async _fileHandle(name, create) {
      const directory = await this.connect();
      try {
        return await directory.getFileHandle(name, create ? { create: true } : undefined);
      } catch (error) {
        if (error && error.name === 'NotFoundError') return null;
        throw error;
      }
    },

    // Force a fresh picker so the user can switch to a different folder.
    // The previous handle is only replaced after the new pick succeeds,
    // so cancelling keeps the current connection intact.
    async pickNew() {
      if (!window.showDirectoryPicker) throw new Error('FOLDER MODE NOT SUPPORTED IN THIS BROWSER');
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await indexedDbSet(DIRECTORY_HANDLE_KEY, handle);
      this.handle = handle;
      return handle;
    },

    async list() {
      const directory = await this.connect();
      const files = [];
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind !== 'file') continue;
        const lower = name.toLowerCase();
        if (!lower.endsWith('.json')) continue;
        if (SharedFiles.has(lower)) continue;
        const file = await handle.getFile();
        files.push({ name, size: file.size, modified: file.lastModified });
      }
      files.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
      return files;
    },

    async _subfolderFileHandle(folder, name, create) {
      const directory = await this.connect();
      const subfolder = await directory.getDirectoryHandle(folder, create ? { create: true } : undefined);
      return subfolder.getFileHandle(name, create ? { create: true } : undefined);
    },

    async read(name) {
      const fileHandle = await this._fileHandle(name, false);
      if (!fileHandle) return null;
      const file = await fileHandle.getFile();
      return await file.text();
    },

    async write(name, json) {
      const fileHandle = await this._fileHandle(name, true);
      const writable = await fileHandle.createWritable();
      await writable.write(json);
      await writable.close();
    },

    async remove(name) {
      const directory = await this.connect();
      await directory.removeEntry(name);
    },

    async readIn(folder, name) {
      try {
        const fileHandle = await this._subfolderFileHandle(folder, name, false);
        if (!fileHandle) return null;
        const file = await fileHandle.getFile();
        return await file.text();
      } catch (error) {
        if (error && error.name === 'NotFoundError') return null;
        throw error;
      }
    },

    // Names of the .json files inside a subfolder; none when it does not exist yet.
    async listIn(folder) {
      const directory = await this.connect();
      let subfolder;
      try {
        subfolder = await directory.getDirectoryHandle(folder);
      } catch (error) {
        if (error && error.name === 'NotFoundError') return [];
        throw error;
      }
      const names = [];
      for await (const [name, handle] of subfolder.entries()) {
        if (handle.kind === 'file' && name.toLowerCase().endsWith('.json')) names.push(name);
      }
      return names.sort();
    },

    async writeIn(folder, name, json) {
      const fileHandle = await this._subfolderFileHandle(folder, name, true);
      const writable = await fileHandle.createWritable();
      await writable.write(json);
      await writable.close();
    },

    async removeIn(folder, name) {
      const directory = await this.connect();
      let subfolder = directory;
      try {
        subfolder = await directory.getDirectoryHandle(folder);
        await subfolder.removeEntry(name);
      } catch (error) { /* already gone */ }
    },

    async backup(name, json) {
      const folder = await this.connect();
      let content = json;
      const existing = await this.read(name);
      if (existing != null) content = existing;

      let backupsFolder;
      try {
        backupsFolder = await folder.getDirectoryHandle('Backups', { create: true });
      } catch (error) { return; }
      const profileName = name.replace(/\.json$/i, '');
      const backupFileHandle = await backupsFolder.getFileHandle(profileName + '-' + timestamp() + '.json', { create: true });
      const writable = await backupFileHandle.createWritable();
      await writable.write(content);
      await writable.close();
      // Backups on disk are never deleted by the app: they are small and the user owns the folder.
    }
  };

  // ==================== File mode (works everywhere) ====================

  const ClassicAdapter = {
    kind: 'classic',

    async connect() { return true; },

    async list() {
      const names = (await indexedDbGet(CLASSIC_FILES_KEY)) || [];
      const files = [];
      for (const name of names) {
        if (SharedFiles.has(name.toLowerCase())) continue;
        if (name.indexOf('/') !== -1) continue; // never show files inside folders
        const meta = await indexedDbGet(CLASSIC_FILE_PREFIX + 'meta:' + name);
        files.push({ name, size: meta ? meta.size : 0, modified: meta ? meta.modified : 0 });
      }
      files.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
      return files;
    },

    async read(name) {
      return (await indexedDbGet(CLASSIC_FILE_PREFIX + name)) || null;
    },

    async write(name, json) {
      await indexedDbSet(CLASSIC_FILE_PREFIX + name, json);
      await indexedDbSet(CLASSIC_FILE_PREFIX + 'meta:' + name, { size: (json || '').length, modified: Date.now() });
      const names = (await indexedDbGet(CLASSIC_FILES_KEY)) || [];
      if (!names.includes(name)) {
        names.push(name);
        await indexedDbSet(CLASSIC_FILES_KEY, names);
      }
    },

    async remove(name) {
      await indexedDbDelete(CLASSIC_FILE_PREFIX + name);
      await indexedDbDelete(CLASSIC_FILE_PREFIX + 'meta:' + name);
      const names = ((await indexedDbGet(CLASSIC_FILES_KEY)) || []).filter(fileName => fileName !== name);
      await indexedDbSet(CLASSIC_FILES_KEY, names);
    },

    async readIn(folder, name) {
      return (await indexedDbGet(CLASSIC_FILE_PREFIX + folder + '/' + name)) || null;
    },

    async listIn(folder) {
      const prefix = CLASSIC_FILE_PREFIX + folder + '/';
      return (await indexedDbKeys())
        .filter((key) => typeof key === 'string' && key.startsWith(prefix) && key.toLowerCase().endsWith('.json'))
        .map((key) => key.slice(prefix.length))
        .filter((name) => name.indexOf('/') === -1)
        .sort();
    },

    async writeIn(folder, name, json) {
      // Files inside folders live outside the profile picker, so they are stored
      // with a path-mirroring key and never registered in the profile list.
      await indexedDbSet(CLASSIC_FILE_PREFIX + folder + '/' + name, json);
    },

    async removeIn(folder, name) {
      await indexedDbDelete(CLASSIC_FILE_PREFIX + folder + '/' + name);
    },

    async backup(name, json) {
      const list = (await indexedDbGet(CLASSIC_BACKUPS_PREFIX + name)) || [];
      list.push({ at: timestamp(), json });
      while (list.length > MAX_BACKUPS) list.shift();
      await indexedDbSet(CLASSIC_BACKUPS_PREFIX + name, list);
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

  // Pin a storage mode for this page session without persisting the preference
  // to localStorage. Used by the standalone market view so guests cache market
  // data in this browser's IndexedDB and no folder picker is ever shown, while
  // the main app keeps its chosen mode on the same machine.
  async function setSessionMode(mode) {
    if (mode !== 'dir' && mode !== 'classic') throw new Error('Unknown storage mode: ' + mode);
    adapter = mode === 'dir' ? DirectoryAdapter : ClassicAdapter;
    return adapter;
  }

  // Pass an opened file through navigation (classic mode: index -> app)
  function setPendingOpen(entry) {
    try { sessionStorage.setItem(PENDING_OPEN_KEY, JSON.stringify(entry)); } catch (error) { /* ignored */ }
  }

  function consumePendingOpen() {
    try {
      const raw = sessionStorage.getItem(PENDING_OPEN_KEY);
      sessionStorage.removeItem(PENDING_OPEN_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) { return null; }
  }

  // Carry the reason a profile could not be opened back to the picker page (app -> index)
  function setOpenError(message) {
    try { sessionStorage.setItem(OPEN_ERROR_KEY, message); } catch (error) { /* ignored */ }
  }

  function consumeOpenError() {
    try {
      const message = sessionStorage.getItem(OPEN_ERROR_KEY);
      sessionStorage.removeItem(OPEN_ERROR_KEY);
      return message;
    } catch (error) { return null; }
  }

  async function pickNewFolder() {
    // Opening a folder is always a deliberate, gesture-driven act: force the
    // picker even if a handle from a previous session exists.
    const folderAdapter = await setMode('dir');
    return folderAdapter.pickNew();
  }

  return {
    get,
    setMode,
    setSessionMode,
    supportsDirectory: () => !!window.showDirectoryPicker,
    pickNewFolder,
    timestamp,
    download,
    openFileDialog,
    normalizeFileName,
    setPendingOpen,
    consumePendingOpen,
    setOpenError,
    consumeOpenError,
    LAST_FILE_KEY
  };
})();
