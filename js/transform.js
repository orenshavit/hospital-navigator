/**
 * Affine transformation between GPS coordinates and image pixel coordinates.
 *
 * Given 3+ reference points that map GPS (lat, lng) to pixel (x, y),
 * computes an affine transform:
 *   pixel_x = a1 * lat + b1 * lng + c1
 *   pixel_y = a2 * lat + b2 * lng + c2
 *
 * Uses least-squares fitting when more than 3 points are provided
 * for increased accuracy.
 */
class AffineTransform {
    constructor() {
        this._params = null;
    }

    compute(referencePoints) {
        if (referencePoints.length < 3) return false;

        const A = referencePoints.map(p => [p.gps.lat, p.gps.lng, 1]);
        const bx = referencePoints.map(p => p.pixel.x);
        const by = referencePoints.map(p => p.pixel.y);

        const xParams = solveLeastSquares(A, bx);
        const yParams = solveLeastSquares(A, by);

        if (!xParams || !yParams) return false;

        this._params = {
            a1: xParams[0], b1: xParams[1], c1: xParams[2],
            a2: yParams[0], b2: yParams[1], c2: yParams[2]
        };

        return true;
    }

    gpsToPixel(lat, lng) {
        if (!this._params) return null;
        const { a1, b1, c1, a2, b2, c2 } = this._params;
        return {
            x: a1 * lat + b1 * lng + c1,
            y: a2 * lat + b2 * lng + c2
        };
    }

    isReady() {
        return this._params !== null;
    }

    getParams() {
        return this._params;
    }

    setParams(params) {
        this._params = params;
    }
}

function solveLeastSquares(A, b) {
    const n = A.length;
    const m = 3;

    const ATA = Array.from({ length: m }, () => new Array(m).fill(0));
    for (let i = 0; i < m; i++) {
        for (let j = 0; j < m; j++) {
            for (let k = 0; k < n; k++) {
                ATA[i][j] += A[k][i] * A[k][j];
            }
        }
    }

    const ATb = new Array(m).fill(0);
    for (let i = 0; i < m; i++) {
        for (let k = 0; k < n; k++) {
            ATb[i] += A[k][i] * b[k];
        }
    }

    return solveGaussian(ATA, ATb);
}

function solveGaussian(matrix, vector) {
    const n = matrix.length;
    const aug = matrix.map((row, i) => [...row, vector[i]]);

    for (let col = 0; col < n; col++) {
        let maxVal = Math.abs(aug[col][col]);
        let maxRow = col;
        for (let row = col + 1; row < n; row++) {
            if (Math.abs(aug[row][col]) > maxVal) {
                maxVal = Math.abs(aug[row][col]);
                maxRow = row;
            }
        }

        if (maxVal < 1e-15) return null;

        if (maxRow !== col) {
            [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
        }

        for (let row = col + 1; row < n; row++) {
            const factor = aug[row][col] / aug[col][col];
            for (let j = col; j <= n; j++) {
                aug[row][j] -= factor * aug[col][j];
            }
        }
    }

    const result = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
        result[i] = aug[i][n];
        for (let j = i + 1; j < n; j++) {
            result[i] -= aug[i][j] * result[j];
        }
        result[i] /= aug[i][i];
    }

    return result;
}
