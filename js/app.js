const GPS_BUFFER_SIZE = 10;
const MIN_CALIBRATION_POINTS = 3;
const MIN_RECORD_DISTANCE_PX = 5;
const GPS_OUTLIER_JUMP_M = 50;
const GPS_MAX_ACCURACY_M = 100;
const KALMAN_PROCESS_NOISE = 2;
const KALMAN_INIT_VARIANCE = 100;

class HospitalNavigator {
    constructor() {
        this._map = null;
        this._store = null;
        this._activeMap = null;
        this._imageOverlay = null;
        this._imageBounds = null;
        this._transform = new AffineTransform();
        this._calibrationPoints = [];
        this._calibrationMarkers = [];
        this._userMarker = null;
        this._accuracyCircle = null;
        this._isCalibrating = false;
        this._isTracking = false;
        this._watchId = null;
        this._currentGPS = null;
        this._gpsBuffer = [];
        this._toastTimeout = null;

        this._isRecording = false;
        this._currentRecordingPath = [];
        this._pathPolylines = [];
        this._liveRecordingLine = null;

        this._isPlacing = false;
        this._placeMarkers = [];

        this._routePolyline = null;
        this._graph = null;

        this._kalman = null;
        this._isOutOfBounds = false;
    }

    async init() {
        this._store = await new MapStore().init();
        this._initMap();
        await this._loadActiveMap();
        this._bindEvents();
        this._updateCalibrationUI();
        this._checkFirstVisit();
    }

    // ===== Map Setup =====

    _initMap() {
        this._map = L.map('map', {
            crs: L.CRS.Simple,
            minZoom: -5,
            maxZoom: 5,
            zoomSnap: 0,
            zoomDelta: 1,
            wheelPxPerZoomLevel: 120,
            attributionControl: false,
            zoomControl: false,
            rotate: true,
            touchRotate: true,
            shiftKeyRotate: true,
            bearing: 0,
            bounceAtZoomLimits: false
        });

        L.control.zoom({ position: 'topleft' }).addTo(this._map);
        this._map.on('rotate', () => this._onMapRotate());
    }

    async _loadActiveMap() {
        const meta = this._store.getActiveMap();
        if (!meta) return;
        await this._displayMap(meta);
    }

    async _displayMap(meta) {
        this._activeMap = meta;
        const imageUrl = await this._store.getImageURL(meta.id);

        if (!imageUrl) {
            this._showToast('Map image was lost. Falling back to default.', 'error');
            const fallback = this._store.getActiveMap();
            if (fallback && fallback.id !== meta.id) {
                return this._displayMap(fallback);
            }
            return;
        }

        if (this._imageOverlay) {
            this._map.removeLayer(this._imageOverlay);
        }

        this._imageBounds = [[0, 0], [meta.height, meta.width]];
        this._imageOverlay = L.imageOverlay(imageUrl, this._imageBounds).addTo(this._map);
        this._map.fitBounds(this._imageBounds);

        this._calibrationPoints = meta.calibration.points || [];
        this._transform = new AffineTransform();
        if (this._calibrationPoints.length >= MIN_CALIBRATION_POINTS) {
            this._transform.compute(this._calibrationPoints);
        } else if (meta.calibration.transformParams) {
            this._transform.setParams(meta.calibration.transformParams);
        }

        this._removeUserMarker();
        this._clearCalibrationMarkers();
        this._updateCalibrationUI();
        this._updateMapSelector();
        this._clearPathPolylines();
        this._clearPlaceMarkers();
        await this._loadPaths();
        this._renderPlaceMarkers();
    }

    // ===== Event Binding =====

    _bindEvents() {
        document.getElementById('btn-locate').addEventListener('click', () => this._toggleTracking());
        document.getElementById('btn-calibrate').addEventListener('click', () => this._enterCalibration());
        document.getElementById('btn-close-calibration').addEventListener('click', () => this._exitCalibration());
        document.getElementById('btn-clear-calibration').addEventListener('click', () => this._clearCalibration());
        document.getElementById('btn-done-calibration').addEventListener('click', () => this._finishCalibration());
        document.getElementById('btn-get-started').addEventListener('click', () => this._dismissOnboarding());
        document.getElementById('btn-compass').addEventListener('click', () => this._resetRotation());
        document.getElementById('btn-fit').addEventListener('click', () => this._fitToScreen());

        document.getElementById('map-selector').addEventListener('click', () => this._toggleMapMenu());
        document.getElementById('btn-close-maps').addEventListener('click', () => this._closeMapMenu());
        document.getElementById('btn-upload-map').addEventListener('click', () => this._triggerUpload());
        document.getElementById('map-file-input').addEventListener('change', (e) => this._handleFileUpload(e));
        document.getElementById('btn-export-maps').addEventListener('click', () => this._exportMaps());
        document.getElementById('btn-import-maps').addEventListener('click', () => document.getElementById('import-file-input').click());
        document.getElementById('import-file-input').addEventListener('change', (e) => this._importMaps(e));

        document.getElementById('btn-record').addEventListener('click', () => this._toggleRecording());
        document.getElementById('btn-add-place').addEventListener('click', () => this._togglePlacing());
        document.getElementById('btn-close-places').addEventListener('click', () => this._closePlacesPanel());
        document.getElementById('btn-manage-places-done').addEventListener('click', () => this._closePlacesPanel());
        document.getElementById('btn-clear-paths').addEventListener('click', () => this._clearAllPaths());

        document.getElementById('btn-directions').addEventListener('click', () => this._toggleDirections());
        document.getElementById('btn-close-directions').addEventListener('click', () => this._closeDirections());
        document.getElementById('btn-get-directions').addEventListener('click', () => this._getDirections());
        document.getElementById('btn-clear-route').addEventListener('click', () => this._clearRoute());
        document.getElementById('btn-swap-directions').addEventListener('click', () => this._swapDirections());

        this._map.on('click', (e) => this._onMapClick(e));
    }

    // ===== Rotation =====

    _onMapRotate() {
        const bearing = this._map.getBearing();
        const icon = document.getElementById('compass-icon');
        if (icon) {
            icon.style.transform = `rotate(${-bearing}deg)`;
        }
    }

    _resetRotation() {
        this._map.setBearing(0);
        this._onMapRotate();
    }

    // ===== Fit to Screen =====

    _fitToScreen() {
        if (!this._imageBounds) return;
        this._map.setBearing(0);
        this._onMapRotate();
        this._map.fitBounds(this._imageBounds);
    }

    // ===== Map Menu =====

    _toggleMapMenu() {
        const panel = document.getElementById('maps-panel');
        panel.classList.toggle('hidden');
        if (!panel.classList.contains('hidden')) {
            this._renderMapList();
        }
    }

    _closeMapMenu() {
        document.getElementById('maps-panel').classList.add('hidden');
    }

    _renderMapList() {
        const container = document.getElementById('maps-list');
        const maps = this._store.getAllMaps();
        const activeId = this._store.getActiveMapId();

        container.innerHTML = maps.map(m => {
            const isActive = m.id === activeId;
            const isCalibrated = m.calibration.transformParams !== null;
            const ptCount = m.calibration.points.length;
            return `
                <div class="map-item ${isActive ? 'map-item-active' : ''}" data-id="${m.id}">
                    <div class="map-item-info">
                        <span class="map-item-name">${this._escapeHtml(m.name)}</span>
                        <span class="map-item-meta">
                            ${m.width}x${m.height}
                            ${isCalibrated ? ` · Calibrated (${ptCount} pts)` : ptCount > 0 ? ` · ${ptCount} pts` : ' · Not calibrated'}
                        </span>
                    </div>
                    <div class="map-item-actions">
                        ${m.id !== '__default__' ? `<button class="btn-map-delete" data-id="${m.id}" aria-label="Delete map">&times;</button>` : ''}
                    </div>
                </div>
            `;
        }).join('');

        container.querySelectorAll('.map-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.btn-map-delete')) return;
                this._onSelectMap(el.dataset.id);
            });
        });

        container.querySelectorAll('.btn-map-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._onDeleteMap(btn.dataset.id);
            });
        });
    }

    async _onSelectMap(id) {
        if (id === this._store.getActiveMapId()) {
            this._closeMapMenu();
            return;
        }

        if (this._isCalibrating) this._exitCalibration();
        if (this._isRecording) this._stopRecording();
        if (this._isTracking) this._stopTracking();
        if (this._isPlacing) this._exitPlacing();
        this._clearRoute();

        this._store.setActiveMap(id);
        const meta = this._store.getMapMeta(id);
        await this._displayMap(meta);
        this._closeMapMenu();
        this._showToast(`Switched to "${meta.name}"`);
    }

    async _onDeleteMap(id) {
        const meta = this._store.getMapMeta(id);
        if (!meta) return;
        if (!confirm(`Delete "${meta.name}"?`)) return;

        await this._store.deleteMap(id);

        if (this._store.getActiveMapId() && this._store.getActiveMapId() !== this._activeMap?.id) {
            const newMeta = this._store.getActiveMap();
            if (newMeta) await this._displayMap(newMeta);
        }

        this._renderMapList();
        this._showToast(`"${meta.name}" deleted`);
    }

    // ===== Upload =====

    _triggerUpload() {
        document.getElementById('map-file-input').click();
    }

    async _handleFileUpload(e) {
        const file = e.target.files[0];
        if (!file) return;
        e.target.value = '';

        if (!file.type.startsWith('image/')) {
            this._showToast('Please select an image file', 'error');
            return;
        }

        const defaultName = file.name.replace(/\.[^.]+$/, '');
        this._showPrompt('Name this map', defaultName, async (name) => {
            try {
                this._showToast('Uploading map...');
                const meta = await this._store.addMap(name.trim(), file);
                await this._displayMap(meta);
                this._closeMapMenu();
                this._showToast(`"${meta.name}" added`, 'success');
            } catch {
                this._showToast('Failed to upload map', 'error');
            }
        });
    }

    async _exportMaps() {
        try {
            this._showToast('Preparing export...');
            const bundle = await this._store.exportAll();
            const json = JSON.stringify(bundle);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = 'hospital-nav-maps.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            this._showToast('Maps exported', 'success');
        } catch {
            this._showToast('Export failed', 'error');
        }
    }

    async _importMaps(e) {
        const file = e.target.files[0];
        if (!file) return;
        e.target.value = '';

        try {
            this._showToast('Importing maps...');
            const text = await file.text();
            const bundle = JSON.parse(text);
            await this._store.importAll(bundle);

            const meta = this._store.getActiveMap();
            if (meta) await this._displayMap(meta);
            this._renderMapList();
            this._showToast('Maps imported', 'success');
        } catch {
            this._showToast('Invalid import file', 'error');
        }
    }

    _updateMapSelector() {
        const el = document.getElementById('map-selector-name');
        if (el && this._activeMap) {
            el.textContent = this._activeMap.name;
        }
    }

    // ===== Onboarding =====

    _checkFirstVisit() {
        const seen = localStorage.getItem('hospital-nav-onboarded');
        if (!seen) {
            document.getElementById('onboarding-overlay').classList.remove('hidden');
        }
    }

    _dismissOnboarding() {
        document.getElementById('onboarding-overlay').classList.add('hidden');
        localStorage.setItem('hospital-nav-onboarded', '1');
    }

    // ===== GPS Tracking =====

    _toggleTracking() {
        if (this._isTracking) {
            this._stopTracking();
        } else {
            this._startTracking();
        }
    }

    _startTracking() {
        if (!navigator.geolocation) {
            this._showToast('GPS is not supported on this device', 'error');
            return;
        }

        if (!this._transform.isReady()) {
            this._showToast('Calibrate the map first', 'error');
            return;
        }

        this._isTracking = true;
        document.getElementById('btn-locate').classList.add('tracking');
        this._updateGPSStatus('Locating...', '');

        this._watchId = navigator.geolocation.watchPosition(
            (pos) => this._onGPSUpdate(pos),
            (err) => this._onGPSError(err),
            { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
        );
    }

    _stopTracking() {
        if (this._isRecording) this._stopRecording();

        this._isTracking = false;
        document.getElementById('btn-locate').classList.remove('tracking');

        if (this._watchId !== null) {
            navigator.geolocation.clearWatch(this._watchId);
            this._watchId = null;
        }

        this._removeUserMarker();
        this._updateGPSStatus('GPS: Inactive', '');
        this._kalman = null;
        this._gpsBuffer = [];

        if (this._isOutOfBounds) {
            this._isOutOfBounds = false;
            this._showOutOfBoundsBanner(false);
        }
    }

    _onGPSUpdate(position) {
        const { latitude, longitude, accuracy } = position.coords;

        if (accuracy > GPS_MAX_ACCURACY_M) return;

        if (this._gpsBuffer.length > 0) {
            const last = this._gpsBuffer[this._gpsBuffer.length - 1];
            const jump = haversineDistance(last.lat, last.lng, latitude, longitude);
            if (jump > GPS_OUTLIER_JUMP_M && accuracy > 15) return;
        }

        this._gpsBuffer.push({ lat: latitude, lng: longitude, accuracy });
        if (this._gpsBuffer.length > GPS_BUFFER_SIZE) {
            this._gpsBuffer.shift();
        }

        const smoothed = this._kalmanUpdate(latitude, longitude, accuracy);

        this._currentGPS = { lat: smoothed.lat, lng: smoothed.lng, accuracy };

        const statusClass = accuracy < 10 ? 'active' : (accuracy < 30 ? '' : 'error');
        this._updateGPSStatus(`GPS: ±${Math.round(accuracy)}m`, statusClass);

        if (this._isCalibrating) return;

        if (this._transform.isReady()) {
            this._updateUserPosition(smoothed.lat, smoothed.lng, accuracy);

            if (this._isRecording) {
                this._recordPoint(smoothed.lat, smoothed.lng);
            }
        }
    }

    _kalmanUpdate(lat, lng, accuracy) {
        if (!this._kalman) {
            this._kalman = {
                lat, lng,
                variance: KALMAN_INIT_VARIANCE
            };
            return { lat, lng };
        }

        const k = this._kalman;
        const predicted_var = k.variance + KALMAN_PROCESS_NOISE;
        const measurement_var = accuracy * accuracy;
        const gain = predicted_var / (predicted_var + measurement_var);

        k.lat = k.lat + gain * (lat - k.lat);
        k.lng = k.lng + gain * (lng - k.lng);
        k.variance = (1 - gain) * predicted_var;

        return { lat: k.lat, lng: k.lng };
    }

    _onGPSError(error) {
        const messages = {
            1: 'Location permission denied',
            2: 'Position unavailable',
            3: 'Location request timed out'
        };
        this._showToast(messages[error.code] || 'GPS error', 'error');
        this._updateGPSStatus('GPS: Error', 'error');
    }

    _getAveragedGPS() {
        if (this._gpsBuffer.length === 0) return this._currentGPS;

        let totalWeight = 0;
        let wLat = 0;
        let wLng = 0;

        for (const p of this._gpsBuffer) {
            const w = 1 / (p.accuracy * p.accuracy);
            wLat += p.lat * w;
            wLng += p.lng * w;
            totalWeight += w;
        }

        const n = this._gpsBuffer.length;
        const avgAccuracy = this._gpsBuffer.reduce((a, p) => a + p.accuracy, 0) / n;

        return {
            lat: wLat / totalWeight,
            lng: wLng / totalWeight,
            accuracy: avgAccuracy
        };
    }

    // ===== User Position Display =====

    _updateUserPosition(lat, lng, accuracy) {
        const pixel = this._transform.gpsToPixel(lat, lng);
        if (!pixel) return;

        const oob = this._isPixelOutOfBounds(pixel.x, pixel.y);
        if (oob !== this._isOutOfBounds) {
            this._isOutOfBounds = oob;
            this._showOutOfBoundsBanner(oob);
        }

        const leafletPos = this._pixelToLeaflet(pixel.x, pixel.y);

        if (!this._userMarker) {
            const icon = L.divIcon({
                className: 'user-location-dot',
                html: '<div class="user-dot-pulse"></div><div class="user-dot-inner"></div>',
                iconSize: [18, 18],
                iconAnchor: [9, 9]
            });
            this._userMarker = L.marker(leafletPos, { icon, zIndexOffset: 1000 }).addTo(this._map);
        } else {
            this._userMarker.setLatLng(leafletPos);
        }

        this._updateAccuracyCircle(leafletPos, accuracy);
    }

    _isPixelOutOfBounds(x, y) {
        if (!this._activeMap) return false;
        const margin = 50;
        return x < -margin || y < -margin ||
               x > this._activeMap.width + margin ||
               y > this._activeMap.height + margin;
    }

    _showOutOfBoundsBanner(show) {
        const banner = document.getElementById('oob-banner');
        if (show) {
            banner.classList.remove('hidden');
        } else {
            banner.classList.add('hidden');
        }
    }

    _updateAccuracyCircle(center, accuracyMeters) {
        const pixelRadius = this._estimatePixelRadius(accuracyMeters);

        if (!this._accuracyCircle) {
            this._accuracyCircle = L.circle(center, {
                radius: pixelRadius,
                className: 'accuracy-circle',
                weight: 1,
                fillOpacity: 0.12,
                interactive: false
            }).addTo(this._map);
        } else {
            this._accuracyCircle.setLatLng(center);
            this._accuracyCircle.setRadius(pixelRadius);
        }
    }

    _estimatePixelRadius(meters) {
        if (this._calibrationPoints.length < 2) return 30;

        const p1 = this._calibrationPoints[0];
        const p2 = this._calibrationPoints[1];

        const gpsDistMeters = haversineDistance(
            p1.gps.lat, p1.gps.lng,
            p2.gps.lat, p2.gps.lng
        );

        const pixelDist = Math.sqrt(
            (p2.pixel.x - p1.pixel.x) ** 2 +
            (p2.pixel.y - p1.pixel.y) ** 2
        );

        if (gpsDistMeters < 0.1) return 30;

        const pixelsPerMeter = pixelDist / gpsDistMeters;
        return Math.max(5, meters * pixelsPerMeter);
    }

    _removeUserMarker() {
        if (this._userMarker) {
            this._map.removeLayer(this._userMarker);
            this._userMarker = null;
        }
        if (this._accuracyCircle) {
            this._map.removeLayer(this._accuracyCircle);
            this._accuracyCircle = null;
        }
    }

    // ===== Calibration =====

    _enterCalibration() {
        this._isCalibrating = true;
        document.getElementById('calibration-panel').classList.remove('hidden');
        document.getElementById('btn-calibrate').classList.add('active');

        if (!this._watchId && navigator.geolocation) {
            this._watchId = navigator.geolocation.watchPosition(
                (pos) => this._onGPSUpdate(pos),
                (err) => this._onGPSError(err),
                { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
            );
        }

        this._removeUserMarker();
        this._renderCalibrationMarkers();
        this._showToast('Tap on the map at your current location');
    }

    _exitCalibration() {
        this._isCalibrating = false;
        document.getElementById('calibration-panel').classList.add('hidden');
        document.getElementById('btn-calibrate').classList.remove('active');

        if (!this._isTracking && this._watchId !== null) {
            navigator.geolocation.clearWatch(this._watchId);
            this._watchId = null;
            this._updateGPSStatus('GPS: Inactive', '');
        }
    }

    _onMapClick(e) {
        if (this._isPlacing) {
            this._addPlaceAtClick(e);
            return;
        }

        if (!this._isCalibrating) return;

        const gps = this._currentGPS;
        if (!gps) {
            this._showToast('Waiting for GPS signal...', 'error');
            return;
        }

        if (gps.accuracy > 50) {
            this._showToast(`GPS accuracy is low (±${Math.round(gps.accuracy)}m). Try moving near a window.`, 'error');
            return;
        }

        const averaged = this._getAveragedGPS();
        const pixel = this._leafletToPixel(e.latlng.lat, e.latlng.lng);
        const pointAccuracy = averaged.accuracy || gps.accuracy;

        const point = {
            gps: { lat: averaged.lat, lng: averaged.lng },
            pixel: { x: pixel.x, y: pixel.y },
            accuracy: pointAccuracy
        };

        this._calibrationPoints.push(point);
        this._addCalibrationMarker(point, this._calibrationPoints.length);
        this._updateCalibrationUI();
        this._saveCalibration();

        this._showToast(
            `Point ${this._calibrationPoints.length} added (±${Math.round(pointAccuracy)}m)`,
            'success'
        );
    }

    _clearCalibration() {
        this._calibrationPoints = [];
        this._clearCalibrationMarkers();
        this._transform = new AffineTransform();
        this._updateCalibrationUI();
        if (this._activeMap) {
            this._store.clearCalibration(this._activeMap.id);
        }
        this._showToast('Calibration cleared');
    }

    _finishCalibration() {
        if (this._calibrationPoints.length < MIN_CALIBRATION_POINTS) {
            this._showToast(`Need at least ${MIN_CALIBRATION_POINTS} points`, 'error');
            return;
        }

        const success = this._transform.compute(this._calibrationPoints);
        if (!success) {
            this._showToast('Calibration failed. Points may be collinear — try different positions.', 'error');
            return;
        }

        this._saveCalibration();
        this._exitCalibration();
        this._clearCalibrationMarkers();
        this._updateCalibrationUI();

        const count = this._calibrationPoints.length;
        this._showToast(`Calibration updated with ${count} points!`, 'success');
    }

    _saveCalibration() {
        if (!this._activeMap) return;
        this._store.saveCalibration(
            this._activeMap.id,
            this._calibrationPoints,
            this._transform.getParams()
        );
    }

    _addCalibrationMarker(point, index) {
        const pos = this._pixelToLeaflet(point.pixel.x, point.pixel.y);
        const acc = point.accuracy || 0;
        const accClass = acc < 10 ? 'cal-marker-good' : (acc < 30 ? 'cal-marker-ok' : 'cal-marker-poor');
        const icon = L.divIcon({
            className: `cal-marker ${accClass}`,
            html: `${index}`,
            iconSize: [28, 28],
            iconAnchor: [14, 14]
        });
        const marker = L.marker(pos, { icon }).addTo(this._map);
        this._calibrationMarkers.push(marker);
    }

    _renderCalibrationMarkers() {
        this._clearCalibrationMarkers();
        this._calibrationPoints.forEach((point, i) => {
            this._addCalibrationMarker(point, i + 1);
        });
    }

    _clearCalibrationMarkers() {
        this._calibrationMarkers.forEach(m => this._map.removeLayer(m));
        this._calibrationMarkers = [];
    }

    _removeCalibrationPoint(index) {
        this._calibrationPoints.splice(index, 1);
        this._renderCalibrationMarkers();
        this._updateCalibrationUI();
        this._saveCalibration();
    }

    _updateCalibrationUI() {
        const count = this._calibrationPoints.length;
        const isCalibrated = this._transform.isReady();

        document.getElementById('point-count-num').textContent = count;

        const counterCircle = document.getElementById('counter-circle');
        counterCircle.classList.toggle('ready', count >= MIN_CALIBRATION_POINTS);

        const label = document.getElementById('point-count-label');
        label.textContent = count === 1 ? '1 point collected' : `${count} points collected`;

        const doneBtn = document.getElementById('btn-done-calibration');
        doneBtn.disabled = count < MIN_CALIBRATION_POINTS;

        const badge = document.getElementById('calibration-badge');
        const badgeText = document.getElementById('calibration-badge-text');
        if (isCalibrated) {
            badge.classList.add('calibrated');
            badgeText.textContent = `Calibrated (${count} pts)`;
        } else {
            badge.classList.remove('calibrated');
            badgeText.textContent = 'Not Calibrated';
        }

        this._renderPointsList();
    }

    _renderPointsList() {
        const container = document.getElementById('calibration-points-list');
        container.innerHTML = this._calibrationPoints.map((p, i) => {
            const acc = p.accuracy || 0;
            const accClass = acc < 10 ? 'acc-good' : (acc < 30 ? 'acc-ok' : 'acc-poor');
            const accText = acc > 0 ? `±${Math.round(acc)}m` : '';
            return `
            <div class="cal-point-item">
                <span class="point-label">#${i + 1}</span>
                <span class="point-coords">${p.gps.lat.toFixed(6)}, ${p.gps.lng.toFixed(6)}</span>
                ${accText ? `<span class="point-accuracy ${accClass}">${accText}</span>` : ''}
                <button class="btn-remove" data-index="${i}" aria-label="Remove point">&times;</button>
            </div>
        `;
        }).join('');

        container.querySelectorAll('.btn-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.currentTarget.dataset.index);
                this._removeCalibrationPoint(idx);
            });
        });
    }

    // ===== Path Recording =====

    _toggleRecording() {
        if (this._isRecording) {
            this._stopRecording();
        } else {
            this._startRecording();
        }
    }

    _startRecording() {
        if (!this._transform.isReady()) {
            this._showToast('Calibrate the map first', 'error');
            return;
        }

        if (!this._isTracking) {
            this._startTracking();
        }

        this._isRecording = true;
        this._currentRecordingPath = [];
        document.getElementById('btn-record').classList.add('recording');
        this._showToast('Recording your path...');
    }

    _stopRecording() {
        this._isRecording = false;
        document.getElementById('btn-record').classList.remove('recording');

        if (this._currentRecordingPath.length >= 2 && this._activeMap) {
            this._store.addPathSegment(this._activeMap.id, [...this._currentRecordingPath]);
            this._showToast(`Path saved (${this._currentRecordingPath.length} points)`, 'success');

            if (this._liveRecordingLine) {
                this._liveRecordingLine.setStyle({ color: '#2196F3', weight: 3, opacity: 0.5, dashArray: null });
                this._pathPolylines.push(this._liveRecordingLine);
                this._liveRecordingLine = null;
            }
        } else {
            this._showToast('Path too short, discarded');
            if (this._liveRecordingLine) {
                this._map.removeLayer(this._liveRecordingLine);
                this._liveRecordingLine = null;
            }
        }

        this._currentRecordingPath = [];
    }

    _recordPoint(lat, lng) {
        const pixel = this._transform.gpsToPixel(lat, lng);
        if (!pixel) return;

        if (this._isPixelOutOfBounds(pixel.x, pixel.y)) return;

        const lastPt = this._currentRecordingPath[this._currentRecordingPath.length - 1];
        if (lastPt) {
            const dx = pixel.x - lastPt.x;
            const dy = pixel.y - lastPt.y;
            if (Math.sqrt(dx * dx + dy * dy) < MIN_RECORD_DISTANCE_PX) return;
        }

        this._currentRecordingPath.push({ x: pixel.x, y: pixel.y });

        const leafletPoints = this._currentRecordingPath.map(
            p => this._pixelToLeaflet(p.x, p.y)
        );

        if (this._liveRecordingLine) {
            this._liveRecordingLine.setLatLngs(leafletPoints);
        } else {
            this._liveRecordingLine = L.polyline(leafletPoints, {
                color: '#F44336',
                weight: 4,
                opacity: 0.8,
                dashArray: '8, 6'
            }).addTo(this._map);
        }
    }

    async _loadPaths() {
        if (!this._activeMap) return;
        const paths = await this._store.getPaths(this._activeMap.id);
        for (const segment of paths) {
            const leafletPoints = segment.map(p => this._pixelToLeaflet(p.x, p.y));
            const polyline = L.polyline(leafletPoints, {
                color: '#2196F3',
                weight: 3,
                opacity: 0.5
            }).addTo(this._map);
            this._pathPolylines.push(polyline);
        }
    }

    _clearPathPolylines() {
        this._pathPolylines.forEach(p => this._map.removeLayer(p));
        this._pathPolylines = [];
        if (this._liveRecordingLine) {
            this._map.removeLayer(this._liveRecordingLine);
            this._liveRecordingLine = null;
        }
    }

    async _clearAllPaths() {
        if (!this._activeMap) return;
        if (!confirm('Clear all recorded paths for this map?')) return;
        await this._store.clearPaths(this._activeMap.id);
        this._clearPathPolylines();
        this._showToast('Paths cleared');
    }

    // ===== Places =====

    _togglePlacing() {
        if (this._isPlacing) {
            this._exitPlacing();
            this._openPlacesPanel();
        } else {
            this._enterPlacing();
        }
    }

    _enterPlacing() {
        if (this._isCalibrating) this._exitCalibration();
        this._isPlacing = true;
        document.getElementById('btn-add-place').classList.add('active');
        this._showToast('Tap on the map to add a place');
    }

    _exitPlacing() {
        this._isPlacing = false;
        document.getElementById('btn-add-place').classList.remove('active');
    }

    _openPlacesPanel() {
        document.getElementById('places-panel').classList.remove('hidden');
        this._renderPlacesList();
    }

    _closePlacesPanel() {
        document.getElementById('places-panel').classList.add('hidden');
        this._exitPlacing();
    }

    _addPlaceAtClick(e) {
        if (!this._activeMap) return;
        const pixel = this._leafletToPixel(e.latlng.lat, e.latlng.lng);

        this._showPrompt('Name this place', 'e.g. Cardiology, Room 302', (name) => {
            const place = {
                id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
                name: name.trim(),
                x: pixel.x,
                y: pixel.y
            };

            this._store.addPlace(this._activeMap.id, place);
            this._addPlaceMarker(place);
            this._renderPlacesList();
            this._showToast(`"${place.name}" added`, 'success');
        });
    }

    _addPlaceMarker(place) {
        const pos = this._pixelToLeaflet(place.x, place.y);
        const icon = L.divIcon({
            className: 'place-marker',
            html: `<div class="place-marker-dot"></div><div class="place-marker-label">${this._escapeHtml(place.name)}</div>`,
            iconSize: [0, 0],
            iconAnchor: [6, 6]
        });

        const marker = L.marker(pos, { icon, interactive: true, draggable: true }).addTo(this._map);
        marker._placeId = place.id;

        marker.bindPopup(() => {
            const div = document.createElement('div');
            div.style.textAlign = 'center';
            div.innerHTML = `<strong>${this._escapeHtml(place.name)}</strong><div style="margin-top:8px;display:flex;gap:6px;justify-content:center"></div>`;
            const btns = div.querySelector('div');

            const renameBtn = document.createElement('button');
            renameBtn.textContent = 'Rename';
            renameBtn.style.cssText = 'padding:4px 12px;border:1px solid #2196F3;border-radius:4px;background:none;color:#2196F3;cursor:pointer;font-size:12px';
            renameBtn.addEventListener('click', () => { marker.closePopup(); this._renamePlace(place.id); });

            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'Delete';
            deleteBtn.style.cssText = 'padding:4px 12px;border:1px solid #e74c3c;border-radius:4px;background:none;color:#e74c3c;cursor:pointer;font-size:12px';
            deleteBtn.addEventListener('click', () => { marker.closePopup(); this._deletePlace(place.id); });

            btns.appendChild(renameBtn);
            btns.appendChild(deleteBtn);
            return div;
        }, { closeButton: false, minWidth: 140 });

        marker.on('dragend', () => {
            const newPos = marker.getLatLng();
            const pixel = this._leafletToPixel(newPos.lat, newPos.lng);
            place.x = pixel.x;
            place.y = pixel.y;
            this._store.updatePlace(this._activeMap.id, place.id, { x: pixel.x, y: pixel.y });
            this._showToast(`"${place.name}" moved`, 'success');
        });

        this._placeMarkers.push(marker);
    }

    _renderPlaceMarkers() {
        if (!this._activeMap) return;
        const places = this._store.getPlaces(this._activeMap.id);
        for (const place of places) {
            this._addPlaceMarker(place);
        }
    }

    _clearPlaceMarkers() {
        this._placeMarkers.forEach(m => this._map.removeLayer(m));
        this._placeMarkers = [];
    }

    _renamePlace(placeId) {
        if (!this._activeMap) return;
        const places = this._store.getPlaces(this._activeMap.id);
        const place = places.find(p => p.id === placeId);
        if (!place) return;

        this._showPrompt('Rename place', place.name, (newName) => {
            this._store.updatePlace(this._activeMap.id, placeId, { name: newName.trim() });
            place.name = newName.trim();

            const marker = this._placeMarkers.find(m => m._placeId === placeId);
            if (marker) {
                const icon = L.divIcon({
                    className: 'place-marker',
                    html: `<div class="place-marker-dot"></div><div class="place-marker-label">${this._escapeHtml(newName.trim())}</div>`,
                    iconSize: [0, 0],
                    iconAnchor: [6, 6]
                });
                marker.setIcon(icon);
            }

            this._renderPlacesList();
            this._showToast(`Renamed to "${newName.trim()}"`, 'success');
        });
    }

    _deletePlace(placeId) {
        if (!this._activeMap) return;
        this._store.removePlace(this._activeMap.id, placeId);

        const idx = this._placeMarkers.findIndex(m => m._placeId === placeId);
        if (idx >= 0) {
            this._map.removeLayer(this._placeMarkers[idx]);
            this._placeMarkers.splice(idx, 1);
        }

        this._renderPlacesList();
        this._showToast('Place deleted');
    }

    _renderPlacesList() {
        const container = document.getElementById('places-list');
        if (!this._activeMap) { container.innerHTML = ''; return; }

        const places = this._store.getPlaces(this._activeMap.id);
        container.innerHTML = places.map(p => `
            <div class="place-item">
                <div class="place-item-info">
                    <div class="place-item-dot"></div>
                    <span class="place-item-name">${this._escapeHtml(p.name)}</span>
                </div>
                <div class="place-item-actions">
                    <button class="btn-rename" data-place-id="${p.id}" aria-label="Rename place">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="btn-remove" data-place-id="${p.id}" aria-label="Remove place">&times;</button>
                </div>
            </div>
        `).join('');

        container.querySelectorAll('.btn-rename').forEach(btn => {
            btn.addEventListener('click', () => {
                this._renamePlace(btn.dataset.placeId);
            });
        });

        container.querySelectorAll('.btn-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                this._deletePlace(btn.dataset.placeId);
            });
        });
    }

    // ===== Directions =====

    _toggleDirections() {
        const panel = document.getElementById('directions-panel');
        if (panel.classList.contains('hidden')) {
            this._openDirections();
        } else {
            this._closeDirections();
        }
    }

    async _openDirections() {
        document.getElementById('directions-panel').classList.remove('hidden');
        document.getElementById('btn-directions').classList.add('active');
        await this._populateDirectionsDropdowns();
    }

    _closeDirections() {
        document.getElementById('directions-panel').classList.add('hidden');
        document.getElementById('btn-directions').classList.remove('active');
    }

    async _populateDirectionsDropdowns() {
        if (!this._activeMap) return;
        const places = this._store.getPlaces(this._activeMap.id);

        const fromSelect = document.getElementById('directions-from');
        const toSelect = document.getElementById('directions-to');

        const fromVal = fromSelect.value;
        const toVal = toSelect.value;

        fromSelect.innerHTML = '<option value="__mylocation__">My Location</option>';
        toSelect.innerHTML = '';

        for (const p of places) {
            const opt1 = document.createElement('option');
            opt1.value = p.id;
            opt1.textContent = p.name;
            fromSelect.appendChild(opt1);

            const opt2 = document.createElement('option');
            opt2.value = p.id;
            opt2.textContent = p.name;
            toSelect.appendChild(opt2);
        }

        if (fromVal && fromSelect.querySelector(`option[value="${fromVal}"]`)) fromSelect.value = fromVal;
        if (toVal && toSelect.querySelector(`option[value="${toVal}"]`)) toSelect.value = toVal;
    }

    async _getDirections() {
        if (!this._activeMap) {
            this._showToast('No map loaded', 'error');
            return;
        }

        const paths = await this._store.getPaths(this._activeMap.id);
        if (!paths || paths.length === 0) {
            this._showToast('No recorded paths. Walk and record paths first.', 'error');
            return;
        }

        const fromVal = document.getElementById('directions-from').value;
        const toVal = document.getElementById('directions-to').value;

        if (!toVal) {
            this._showToast('Select a destination', 'error');
            return;
        }

        let fromXY;
        if (fromVal === '__mylocation__') {
            if (!this._currentGPS || !this._transform.isReady()) {
                this._showToast('Enable GPS tracking and calibrate first', 'error');
                return;
            }
            fromXY = this._transform.gpsToPixel(this._currentGPS.lat, this._currentGPS.lng);
            if (!fromXY) {
                this._showToast('Could not determine your position', 'error');
                return;
            }
        } else {
            const places = this._store.getPlaces(this._activeMap.id);
            const fromPlace = places.find(p => p.id === fromVal);
            if (!fromPlace) { this._showToast('Origin not found', 'error'); return; }
            fromXY = { x: fromPlace.x, y: fromPlace.y };
        }

        const places = this._store.getPlaces(this._activeMap.id);
        const toPlace = places.find(p => p.id === toVal);
        if (!toPlace) { this._showToast('Destination not found', 'error'); return; }
        const toXY = { x: toPlace.x, y: toPlace.y };

        this._showToast('Calculating route...');

        this._graph = new WalkableGraph();
        this._graph.build(paths);

        const fromSnap = this._graph.snapPoint(fromXY.x, fromXY.y);
        const toSnap = this._graph.snapPoint(toXY.x, toXY.y);

        if (!fromSnap || !toSnap) {
            this._showToast('Could not connect to walking paths', 'error');
            return;
        }

        const result = this._graph.findRoute(fromSnap.nodeId, toSnap.nodeId);

        if (!result) {
            this._showToast('No route found. Record more paths to connect these locations.', 'error');
            return;
        }

        this._clearRoute();
        const leafletPoints = result.path.map(p => this._pixelToLeaflet(p.x, p.y));
        this._routePolyline = L.polyline(leafletPoints, {
            color: '#009688',
            weight: 6,
            opacity: 0.85,
            lineCap: 'round',
            lineJoin: 'round'
        }).addTo(this._map);

        this._map.fitBounds(this._routePolyline.getBounds(), { padding: [40, 40] });

        const distText = this._formatDistance(result.distance);
        document.getElementById('directions-distance-text').textContent = distText;
        document.getElementById('directions-info').classList.remove('hidden');

        this._showToast('Route found!', 'success');
    }

    _clearRoute() {
        if (this._routePolyline) {
            this._map.removeLayer(this._routePolyline);
            this._routePolyline = null;
        }
        document.getElementById('directions-info').classList.add('hidden');
    }

    _swapDirections() {
        const fromSelect = document.getElementById('directions-from');
        const toSelect = document.getElementById('directions-to');
        const fromVal = fromSelect.value;
        const toVal = toSelect.value;

        if (toVal && fromSelect.querySelector(`option[value="${toVal}"]`)) {
            fromSelect.value = toVal;
        }
        if (fromVal && fromVal !== '__mylocation__' && toSelect.querySelector(`option[value="${fromVal}"]`)) {
            toSelect.value = fromVal;
        }
    }

    _formatDistance(pixelDist) {
        if (this._calibrationPoints.length < 2) {
            return `~${Math.round(pixelDist)} px`;
        }

        const p1 = this._calibrationPoints[0];
        const p2 = this._calibrationPoints[1];
        const gpsDistMeters = haversineDistance(p1.gps.lat, p1.gps.lng, p2.gps.lat, p2.gps.lng);
        const pixelDistCal = Math.sqrt(
            (p2.pixel.x - p1.pixel.x) ** 2 + (p2.pixel.y - p1.pixel.y) ** 2
        );

        if (pixelDistCal < 0.1) return `~${Math.round(pixelDist)} px`;

        const meters = pixelDist * (gpsDistMeters / pixelDistCal);
        if (meters < 1000) return `~${Math.round(meters)} m`;
        return `~${(meters / 1000).toFixed(1)} km`;
    }

    // ===== Coordinate Conversions =====

    _pixelToLeaflet(px, py) {
        if (!this._activeMap) return L.latLng(0, 0);
        return L.latLng(this._activeMap.height - py, px);
    }

    _leafletToPixel(lat, lng) {
        if (!this._activeMap) return { x: 0, y: 0 };
        return { x: lng, y: this._activeMap.height - lat };
    }

    // ===== UI Helpers =====

    _updateGPSStatus(text, className) {
        const el = document.getElementById('gps-status');
        document.getElementById('gps-text').textContent = text;
        el.className = className ? `${className}` : '';
        el.id = 'gps-status';
    }

    _showToast(message, type = '') {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.className = `toast visible ${type ? 'toast-' + type : ''}`;

        clearTimeout(this._toastTimeout);
        this._toastTimeout = setTimeout(() => {
            toast.className = 'toast hidden';
        }, 3000);
    }

    _showPrompt(title, placeholder, onConfirm) {
        const overlay = document.getElementById('prompt-overlay');
        const input = document.getElementById('prompt-input');
        const titleEl = document.getElementById('prompt-title');
        const okBtn = document.getElementById('prompt-ok');
        const cancelBtn = document.getElementById('prompt-cancel');

        titleEl.textContent = title;
        input.placeholder = placeholder;
        input.value = '';
        overlay.classList.remove('hidden');
        input.focus();

        const cleanup = () => {
            overlay.classList.add('hidden');
            okBtn.replaceWith(okBtn.cloneNode(true));
            cancelBtn.replaceWith(cancelBtn.cloneNode(true));
            input.removeEventListener('keydown', onKey);
        };

        const confirm = () => {
            const val = input.value.trim();
            if (!val) { input.focus(); return; }
            cleanup();
            onConfirm(val);
        };

        const onKey = (e) => {
            if (e.key === 'Enter') confirm();
            if (e.key === 'Escape') cleanup();
        };

        document.getElementById('prompt-ok').addEventListener('click', confirm);
        document.getElementById('prompt-cancel').addEventListener('click', cleanup);
        input.addEventListener('keydown', onKey);
    }

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

document.addEventListener('DOMContentLoaded', () => {
    const app = new HospitalNavigator();
    app.init().then(() => { window.app = app; });
});
