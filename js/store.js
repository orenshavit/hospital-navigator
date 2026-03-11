const STORE_KEY = 'hospital-nav-data';
const OLD_STORE_KEY = 'hospital-nav-calibration';
const DB_NAME = 'hospital-nav-db';
const DB_VERSION = 2;
const IMG_STORE = 'images';
const PATHS_STORE = 'paths';
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
        await this._seedDefaultData();
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
            calibration: { points: [], transformParams: null },
            places: []
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

    // ===== Places =====

    getPlaces(mapId) {
        const meta = this._data.maps[mapId];
        return meta ? (meta.places || []) : [];
    }

    addPlace(mapId, place) {
        const meta = this._data.maps[mapId];
        if (!meta) return;
        if (!meta.places) meta.places = [];
        meta.places.push(place);
        this._saveMeta();
    }

    removePlace(mapId, placeId) {
        const meta = this._data.maps[mapId];
        if (!meta || !meta.places) return;
        meta.places = meta.places.filter(p => p.id !== placeId);
        this._saveMeta();
    }

    updatePlace(mapId, placeId, updates) {
        const meta = this._data.maps[mapId];
        if (!meta || !meta.places) return;
        const place = meta.places.find(p => p.id === placeId);
        if (place) Object.assign(place, updates);
        this._saveMeta();
    }

    // ===== Paths =====

    async getPaths(mapId) {
        return await this._getFromStore(PATHS_STORE, mapId) || [];
    }

    async savePaths(mapId, paths) {
        await this._putToStore(PATHS_STORE, mapId, paths);
    }

    async addPathSegment(mapId, segment) {
        const paths = await this.getPaths(mapId);
        paths.push(segment);
        await this.savePaths(mapId, paths);
    }

    async clearPaths(mapId) {
        await this._deleteFromStore(PATHS_STORE, mapId);
    }

    async exportAll() {
        const bundle = { version: 3, maps: {} };
        for (const [id, meta] of Object.entries(this._data.maps)) {
            const imageData = id === DEFAULT_MAP_ID ? null : await this._getImage(id);
            const paths = await this.getPaths(id);
            bundle.maps[id] = { meta: { ...meta }, imageData, paths };
        }
        return bundle;
    }

    async importAll(bundle) {
        if (!bundle || !bundle.maps) throw new Error('Invalid bundle format');

        for (const [id, entry] of Object.entries(bundle.maps)) {
            if (id === DEFAULT_MAP_ID) {
                const def = this._data.maps[DEFAULT_MAP_ID];
                if (def && entry.meta) {
                    if (entry.meta.calibration) def.calibration = entry.meta.calibration;
                    if (entry.meta.places) def.places = entry.meta.places;
                }
                if (entry.paths && entry.paths.length) {
                    await this.savePaths(id, entry.paths);
                }
                continue;
            }
            this._data.maps[id] = entry.meta;
            if (!this._data.maps[id].places) this._data.maps[id].places = [];
            if (entry.imageData) {
                await this._putImage(id, entry.imageData);
            }
            if (entry.paths && entry.paths.length) {
                await this.savePaths(id, entry.paths);
            }
        }
        this._saveMeta();
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
                if (!db.objectStoreNames.contains(PATHS_STORE)) {
                    db.createObjectStore(PATHS_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    _putToStore(storeName, key, value) {
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(storeName, 'readwrite');
            tx.objectStore(storeName).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    _getFromStore(storeName, key) {
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(storeName, 'readonly');
            const req = tx.objectStore(storeName).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    _deleteFromStore(storeName, key) {
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(storeName, 'readwrite');
            tx.objectStore(storeName).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    _putImage(id, dataUrl) {
        return this._putToStore(IMG_STORE, id, dataUrl);
    }

    _getImage(id) {
        return this._getFromStore(IMG_STORE, id);
    }

    _deleteImage(id) {
        return this._deleteFromStore(IMG_STORE, id);
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
                    calibration: { points: [], transformParams: null },
                    places: []
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

    // ===== Seed Defaults =====

    async _seedDefaultData() {
        const hasExistingData = localStorage.getItem(STORE_KEY) !== null;
        if (hasExistingData) return;

        try {
            const resp = await fetch('default-data.json');
            if (!resp.ok) return;
            const bundle = await resp.json();
            await this.importAll(bundle);

            if (bundle.activeMapId && this._data.maps[bundle.activeMapId]) {
                this._data.activeMapId = bundle.activeMapId;
            }
            this._saveMeta();
        } catch {
            // Seed file not available, continue with empty defaults
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
