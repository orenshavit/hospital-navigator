const STORE_KEY = 'hospital-nav-data';
const OLD_STORE_KEY = 'hospital-nav-calibration';
const DB_NAME = 'hospital-nav-db';
const DB_VERSION = 1;
const IMG_STORE = 'images';
const DEFAULT_MAP_ID = '__default__';

class MapStore {
    constructor() {
        this._db = null;
        this._data = null;
    }

    async init() {
        this._db = await this._openDB();
        this._data = this._loadMeta();
        await this._migrateOldFormat();
        return this;
    }

    // ===== Public API =====

    getAllMaps() {
        return Object.values(this._data.maps);
    }

    getMapMeta(id) {
        return this._data.maps[id] || null;
    }

    getActiveMapId() {
        return this._data.activeMapId;
    }

    getActiveMap() {
        return this._data.maps[this._data.activeMapId] || null;
    }

    setActiveMap(id) {
        if (!this._data.maps[id]) return;
        this._data.activeMapId = id;
        this._saveMeta();
    }

    async addMap(name, file) {
        const dataUrl = await this._readFileAsDataURL(file);
        const dims = await this._getImageDimensions(dataUrl);
        const id = this._generateId();

        const mapMeta = {
            id,
            name,
            width: dims.width,
            height: dims.height,
            calibration: { points: [], transformParams: null }
        };

        this._data.maps[id] = mapMeta;
        this._data.activeMapId = id;
        this._saveMeta();

        await this._putImage(id, dataUrl);
        return mapMeta;
    }

    async deleteMap(id) {
        if (id === DEFAULT_MAP_ID) return false;
        delete this._data.maps[id];

        if (this._data.activeMapId === id) {
            const remaining = Object.keys(this._data.maps);
            this._data.activeMapId = remaining.length > 0 ? remaining[0] : null;
        }

        this._saveMeta();
        await this._deleteImage(id);
        return true;
    }

    renameMap(id, name) {
        if (!this._data.maps[id]) return;
        this._data.maps[id].name = name;
        this._saveMeta();
    }

    saveCalibration(id, points, transformParams) {
        if (!this._data.maps[id]) return;
        this._data.maps[id].calibration = { points, transformParams };
        this._saveMeta();
    }

    clearCalibration(id) {
        if (!this._data.maps[id]) return;
        this._data.maps[id].calibration = { points: [], transformParams: null };
        this._saveMeta();
    }

    async getImageURL(id) {
        if (id === DEFAULT_MAP_ID) return 'hospital-map.png';
        const dataUrl = await this._getImage(id);
        if (!dataUrl) {
            delete this._data.maps[id];
            if (this._data.activeMapId === id) {
                this._data.activeMapId = DEFAULT_MAP_ID;
            }
            this._saveMeta();
            return null;
        }
        return dataUrl;
    }

    hasAnyMaps() {
        return Object.keys(this._data.maps).length > 0;
    }

    // ===== IndexedDB =====

    _openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(IMG_STORE)) {
                    db.createObjectStore(IMG_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    _putImage(id, dataUrl) {
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(IMG_STORE, 'readwrite');
            tx.objectStore(IMG_STORE).put(dataUrl, id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    _getImage(id) {
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(IMG_STORE, 'readonly');
            const req = tx.objectStore(IMG_STORE).get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    _deleteImage(id) {
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(IMG_STORE, 'readwrite');
            tx.objectStore(IMG_STORE).delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    // ===== localStorage =====

    _loadMeta() {
        try {
            const raw = localStorage.getItem(STORE_KEY);
            if (raw) {
                const data = JSON.parse(raw);
                if (data.version === 2) return data;
            }
        } catch { /* fall through */ }

        return {
            version: 2,
            activeMapId: DEFAULT_MAP_ID,
            maps: {
                [DEFAULT_MAP_ID]: {
                    id: DEFAULT_MAP_ID,
                    name: 'Default Map',
                    width: 1024,
                    height: 699,
                    calibration: { points: [], transformParams: null }
                }
            }
        };
    }

    _saveMeta() {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(this._data));
        } catch { /* storage full, ignore */ }
    }

    // ===== Migration =====

    async _migrateOldFormat() {
        let raw;
        try {
            raw = localStorage.getItem(OLD_STORE_KEY);
        } catch {
            return;
        }
        if (!raw) return;

        try {
            const old = JSON.parse(raw);
            const defaultMap = this._data.maps[DEFAULT_MAP_ID];
            if (defaultMap) {
                defaultMap.calibration = {
                    points: old.points || [],
                    transformParams: old.transformParams || null
                };
                this._saveMeta();
            }
            localStorage.removeItem(OLD_STORE_KEY);
        } catch {
            localStorage.removeItem(OLD_STORE_KEY);
        }
    }

    // ===== Helpers =====

    _readFileAsDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });
    }

    _getImageDimensions(dataUrl) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () => resolve({ width: 1024, height: 768 });
            img.src = dataUrl;
        });
    }

    _generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    }
}
