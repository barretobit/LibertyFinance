/* ===== Vaulty: save files =====
 *
 * Every game is one JSON file in the Game/ folder of the Liberty Finance data
 * folder, next to Resources/. In folder mode (Chrome, Edge) these are real
 * files on disk; in file mode (Firefox, Safari) they live in this browser's
 * storage under the same Game/ path. The last opened save is remembered per
 * browser, so the page reopens it.
 */

const GameSaves = (() => {
  const FOLDER = 'Game';
  const LAST_SAVE_KEY = 'lf-game-last-save';
  // The first versions of the game kept one game in localStorage.
  const LEGACY_STORAGE_KEY = 'lf-game';

  let adapter = null;

  // True once saves and market data can be read: always in file mode, in
  // folder mode only when the data folder is connected. Picking a folder
  // needs a click, so on page load this can be false until the player clicks.
  async function connect() {
    adapter = await Storage.get();
    if (adapter.kind !== 'dir') return true;
    try {
      await adapter.connect();
      return true;
    } catch (error) {
      return false;
    }
  }

  function folderName() {
    return adapter && adapter.kind === 'dir' && adapter.handle ? adapter.handle.name : null;
  }

  // Version 1 games had no player: they become a Zürich player, and their
  // precious metals, then counted in troy ounces, are counted in grams.
  function migrate(saved) {
    if (!saved || !Array.isArray(saved.trades)) return null;
    let game = saved;
    if (saved.version === 1) {
      game = Object.assign({}, saved, {
        version: 2,
        name: saved.name || 'PLAYER 1',
        location: 'zurich',
        trades: saved.trades.map((trade) => GameTangibles.PRECIOUS_METALS[trade.symbol]
          ? Object.assign({}, trade, { quantity: trade.quantity * GameTangibles.GRAMS_PER_TROY_OUNCE, priceChf: trade.priceChf / GameTangibles.GRAMS_PER_TROY_OUNCE })
          : trade),
      });
    }
    const valid = game.version === 2 && GameEngine.LOCATIONS[game.location] && GameEngine.DIFFICULTIES[game.difficulty] &&
      typeof game.startDate === 'string' && game.startCash > 0;
    return valid ? game : null;
  }

  // A free file name from the player name: "João Silva" -> "joao-silva.json", then "joao-silva-2.json".
  function fileNameFor(name, takenFiles) {
    const base = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'player';
    const taken = new Set((takenFiles || []).map((file) => file.toLowerCase()));
    let file = base + '.json';
    for (let number = 2; taken.has(file); number++) file = base + '-' + number + '.json';
    return file;
  }

  async function read(file) {
    const content = await adapter.readIn(FOLDER, file);
    if (!content) return null;
    try { return migrate(JSON.parse(content)); } catch (error) { return null; }
  }

  async function write(file, game) {
    await adapter.writeIn(FOLDER, file, JSON.stringify(game, null, 2));
  }

  // Every readable save as { file, game }, by player name. Files that are not
  // a game are skipped, not deleted.
  async function list() {
    const saves = [];
    for (const file of await adapter.listIn(FOLDER)) {
      const game = await read(file);
      if (game) saves.push({ file: file, game: game });
    }
    return saves.sort((a, b) => String(a.game.name).localeCompare(String(b.game.name)));
  }

  // Keeps a copy of a save before the file check cleans it, as "<name>-backup-<date>-<time>.json.bak" in the same
  // folder. The .bak ending keeps it out of the list of games; renamed to end in .json it is a game again.
  async function backup(file, game) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    const name = file.replace(/\.json$/i, '') + '-backup-' + stamp + '.json.bak';
    await adapter.writeIn(FOLDER, name, JSON.stringify(game, null, 2));
    return name;
  }

  async function create(game) {
    const file = fileNameFor(game.name, await adapter.listIn(FOLDER));
    await write(file, game);
    return file;
  }

  function lastFile() {
    try { return localStorage.getItem(LAST_SAVE_KEY); } catch (error) { return null; }
  }

  function setLastFile(file) {
    try { localStorage.setItem(LAST_SAVE_KEY, file); } catch (error) { /* only a convenience */ }
  }

  // Moves a game from the old localStorage key into a save file. The old copy
  // is only removed once the file is written.
  async function importLegacy() {
    let raw = null;
    try { raw = localStorage.getItem(LEGACY_STORAGE_KEY); } catch (error) { return; }
    if (!raw) return;
    let game = null;
    try { game = migrate(JSON.parse(raw)); } catch (error) { game = null; }
    if (game) setLastFile(await create(game));
    try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch (error) { /* ignored */ }
  }

  return { FOLDER, connect, folderName, migrate, fileNameFor, read, write, backup, list, create, lastFile, setLastFile, importLegacy };
})();

if (typeof module !== 'undefined') module.exports = GameSaves;
