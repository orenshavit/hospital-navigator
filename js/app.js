const IMAGE_WIDTH = 1024;
const IMAGE_HEIGHT = 699;
const STORAGE_KEY = 'hospital-nav-calibration';
const GPS_BUFFER_SIZE = 5;
const MIN_CALIBRATION_POINTS = 3;

class HospitalNavigator {
    constructor() {
        this._map = null;
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

        this._init();
    }

    _init() {
        this._initMap();
        this._loadCalibration();
        this._bindEvents();
        this._updateCalibrationUI();
        this._checkFirstVisit();
    }

    // ===== Map Setup =====

    _initMap() {
        this._map = L.map('map', {
            crs: L.CRS.Simple,
            minZoom: -2,
            maxZoom: 4,
            zoomSnap: 0.25,
            zoomDelta: 0.5,
            attributionControl: false,
            zoomControl: false,
            rotate: true,
            touchRotate: true,
            shiftKeyRotate: true,
            bearing: 0
        });

        L.control.zoom({ position: 'topleft' }).addTo(this._map);

        const bounds = [[0, 0], [IMAGE_HEIGHT, IMAGE_WIDTH]];
        L.imageOverlay('hospital-map.png', bounds).addTo(this._map);
        this._map.fitBounds(bounds);
        this._map.setMaxBounds([
            [-IMAGE_HEIGHT * 0.2, -IMAGE_WIDTH * 0.2],
            [IMAGE_HEIGHT * 1.2, IMAGE_WIDTH * 1.2]
        ]);

        this._map.on('rotate', () => this._onMapRotate());
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

    // ===== Onboarding =====

    _checkFirstVisit() {
        if (!localStorage.getItem(STORAGE_KEY)) {
            document.getElementById('onboarding-overlay').classList.remove('hidden');
        }
    }

    _dismissOnboarding() {
        document.getElementById('onboarding-overlay').classList.add('hidden');
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
        this._isTracking = false;
        document.getElementById('btn-locate').classList.remove('tracking');

        if (this._watchId !== null) {
            navigator.geolocation.clearWatch(this._watchId);
            this._watchId = null;
        }

        this._removeUserMarker();
        this._updateGPSStatus('GPS: Inactive', '');
    }

    _onGPSUpdate(position) {
        const { latitude, longitude, accuracy } = position.coords;

        this._gpsBuffer.push({ lat: latitude, lng: longitude, accuracy });
        if (this._gpsBuffer.length > GPS_BUFFER_SIZE) {
            this._gpsBuffer.shift();
        }

        this._currentGPS = { lat: latitude, lng: longitude, accuracy };

        const statusClass = accuracy < 10 ? 'active' : (accuracy < 30 ? '' : 'error');
        this._updateGPSStatus(`GPS: ±${Math.round(accuracy)}m`, statusClass);

        if (this._isCalibrating) return;

        if (this._transform.isReady()) {
            this._updateUserPosition(latitude, longitude, accuracy);
        }
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

        const sum = this._gpsBuffer.reduce(
            (acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }),
            { lat: 0, lng: 0 }
        );
        const n = this._gpsBuffer.length;
        const avgAccuracy = this._gpsBuffer.reduce((a, p) => a + p.accuracy, 0) / n;

        return {
            lat: sum.lat / n,
            lng: sum.lng / n,
            accuracy: avgAccuracy
        };
    }

    // ===== User Position Display =====

    _updateUserPosition(lat, lng, accuracy) {
        const pixel = this._transform.gpsToPixel(lat, lng);
        if (!pixel) return;

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

        const point = {
            gps: { lat: averaged.lat, lng: averaged.lng },
            pixel: { x: pixel.x, y: pixel.y }
        };

        this._calibrationPoints.push(point);
        this._addCalibrationMarker(point, this._calibrationPoints.length);
        this._updateCalibrationUI();
        this._saveCalibration();

        this._showToast(
            `Point ${this._calibrationPoints.length} added (±${Math.round(gps.accuracy)}m)`,
            'success'
        );
    }

    _clearCalibration() {
        this._calibrationPoints = [];
        this._clearCalibrationMarkers();
        this._transform = new AffineTransform();
        this._updateCalibrationUI();
        localStorage.removeItem(STORAGE_KEY);
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
        this._showToast('Calibration complete!', 'success');
    }

    _addCalibrationMarker(point, index) {
        const pos = this._pixelToLeaflet(point.pixel.x, point.pixel.y);
        const icon = L.divIcon({
            className: 'cal-marker',
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
        container.innerHTML = this._calibrationPoints.map((p, i) => `
            <div class="cal-point-item">
                <span class="point-label">#${i + 1}</span>
                <span class="point-coords">${p.gps.lat.toFixed(6)}, ${p.gps.lng.toFixed(6)}</span>
                <button class="btn-remove" data-index="${i}" aria-label="Remove point">&times;</button>
            </div>
        `).join('');

        container.querySelectorAll('.btn-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.currentTarget.dataset.index);
                this._removeCalibrationPoint(idx);
            });
        });
    }

    // ===== Persistence =====

    _saveCalibration() {
        const data = {
            version: 1,
            points: this._calibrationPoints,
            transformParams: this._transform.getParams()
        };
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch {
            this._showToast('Could not save calibration data', 'error');
        }
    }

    _loadCalibration() {
        let raw;
        try {
            raw = localStorage.getItem(STORAGE_KEY);
        } catch {
            return;
        }
        if (!raw) return;

        try {
            const data = JSON.parse(raw);
            this._calibrationPoints = data.points || [];

            if (data.transformParams) {
                this._transform.setParams(data.transformParams);
            } else if (this._calibrationPoints.length >= MIN_CALIBRATION_POINTS) {
                this._transform.compute(this._calibrationPoints);
                this._saveCalibration();
            }
        } catch {
            localStorage.removeItem(STORAGE_KEY);
        }
    }

    // ===== Coordinate Conversions =====

    _pixelToLeaflet(px, py) {
        return L.latLng(IMAGE_HEIGHT - py, px);
    }

    _leafletToPixel(lat, lng) {
        return { x: lng, y: IMAGE_HEIGHT - lat };
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
    window.app = new HospitalNavigator();
});
