const JUNCTION_THRESHOLD_PX = 15;

class WalkableGraph {
    constructor() {
        this._nodes = [];
        this._adj = [];
    }

    build(pathSegments) {
        this._nodes = [];
        this._adj = [];

        const nodeIndex = new Map();
        const key = (x, y) => `${Math.round(x)},${Math.round(y)}`;

        const addNode = (x, y) => {
            const k = key(x, y);
            if (nodeIndex.has(k)) return nodeIndex.get(k);
            const id = this._nodes.length;
            this._nodes.push({ x, y });
            this._adj.push([]);
            nodeIndex.set(k, id);
            return id;
        };

        const addEdge = (a, b) => {
            const dx = this._nodes[a].x - this._nodes[b].x;
            const dy = this._nodes[a].y - this._nodes[b].y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 0.01) return;
            if (!this._adj[a].some(e => e.to === b)) {
                this._adj[a].push({ to: b, dist });
                this._adj[b].push({ to: a, dist });
            }
        };

        for (const segment of pathSegments) {
            let prevId = null;
            for (const pt of segment) {
                const id = addNode(pt.x, pt.y);
                if (prevId !== null && prevId !== id) {
                    addEdge(prevId, id);
                }
                prevId = id;
            }
        }

        this._buildJunctions();
        return this;
    }

    _buildJunctions() {
        const n = this._nodes.length;
        if (n < 2) return;

        const cellSize = JUNCTION_THRESHOLD_PX;
        const grid = new Map();

        for (let i = 0; i < n; i++) {
            const cx = Math.floor(this._nodes[i].x / cellSize);
            const cy = Math.floor(this._nodes[i].y / cellSize);
            const gk = `${cx},${cy}`;
            if (!grid.has(gk)) grid.set(gk, []);
            grid.get(gk).push(i);
        }

        const segmentOf = new Int32Array(n).fill(-1);
        let segIdx = 0;
        for (let i = 0; i < n; i++) {
            if (segmentOf[i] >= 0) continue;
            const queue = [i];
            segmentOf[i] = segIdx;
            while (queue.length) {
                const cur = queue.shift();
                for (const edge of this._adj[cur]) {
                    if (segmentOf[edge.to] < 0) {
                        segmentOf[edge.to] = segIdx;
                        queue.push(edge.to);
                    }
                }
            }
            segIdx++;
        }

        for (let i = 0; i < n; i++) {
            const cx = Math.floor(this._nodes[i].x / cellSize);
            const cy = Math.floor(this._nodes[i].y / cellSize);

            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const neighbors = grid.get(`${cx + dx},${cy + dy}`);
                    if (!neighbors) continue;
                    for (const j of neighbors) {
                        if (j <= i) continue;
                        const ddx = this._nodes[i].x - this._nodes[j].x;
                        const ddy = this._nodes[i].y - this._nodes[j].y;
                        const d = Math.sqrt(ddx * ddx + ddy * ddy);
                        if (d < JUNCTION_THRESHOLD_PX) {
                            if (!this._adj[i].some(e => e.to === j)) {
                                this._adj[i].push({ to: j, dist: d });
                                this._adj[j].push({ to: i, dist: d });
                            }
                        }
                    }
                }
            }
        }
    }

    snapPoint(x, y) {
        if (this._nodes.length === 0) return null;

        let bestDist = Infinity;
        let bestPt = null;
        let bestEdge = null;

        for (let i = 0; i < this._nodes.length; i++) {
            for (const edge of this._adj[i]) {
                if (edge.to < i) continue;
                const proj = this._projectOntoSegment(
                    x, y,
                    this._nodes[i].x, this._nodes[i].y,
                    this._nodes[edge.to].x, this._nodes[edge.to].y
                );
                if (proj.dist < bestDist) {
                    bestDist = proj.dist;
                    bestPt = { x: proj.x, y: proj.y };
                    bestEdge = { from: i, to: edge.to };
                }
            }
        }

        if (!bestPt) {
            let closestNode = 0;
            let closestDist = Infinity;
            for (let i = 0; i < this._nodes.length; i++) {
                const dx = this._nodes[i].x - x;
                const dy = this._nodes[i].y - y;
                const d = Math.sqrt(dx * dx + dy * dy);
                if (d < closestDist) { closestDist = d; closestNode = i; }
            }
            return { nodeId: closestNode, dist: closestDist };
        }

        const snapId = this._nodes.length;
        this._nodes.push(bestPt);
        this._adj.push([]);

        const dFrom = Math.sqrt(
            (bestPt.x - this._nodes[bestEdge.from].x) ** 2 +
            (bestPt.y - this._nodes[bestEdge.from].y) ** 2
        );
        const dTo = Math.sqrt(
            (bestPt.x - this._nodes[bestEdge.to].x) ** 2 +
            (bestPt.y - this._nodes[bestEdge.to].y) ** 2
        );

        this._adj[snapId].push({ to: bestEdge.from, dist: dFrom });
        this._adj[bestEdge.from].push({ to: snapId, dist: dFrom });
        this._adj[snapId].push({ to: bestEdge.to, dist: dTo });
        this._adj[bestEdge.to].push({ to: snapId, dist: dTo });

        return { nodeId: snapId, dist: bestDist };
    }

    findRoute(fromNodeId, toNodeId) {
        const n = this._nodes.length;
        if (fromNodeId < 0 || fromNodeId >= n || toNodeId < 0 || toNodeId >= n) return null;
        if (fromNodeId === toNodeId) return { path: [this._nodes[fromNodeId]], distance: 0 };

        const dist = new Float64Array(n).fill(Infinity);
        const prev = new Int32Array(n).fill(-1);
        const visited = new Uint8Array(n);
        dist[fromNodeId] = 0;

        const heap = new MinHeap();
        heap.push(fromNodeId, 0);

        while (heap.size() > 0) {
            const { id: u } = heap.pop();
            if (visited[u]) continue;
            visited[u] = 1;
            if (u === toNodeId) break;

            for (const edge of this._adj[u]) {
                const alt = dist[u] + edge.dist;
                if (alt < dist[edge.to]) {
                    dist[edge.to] = alt;
                    prev[edge.to] = u;
                    heap.push(edge.to, alt);
                }
            }
        }

        if (dist[toNodeId] === Infinity) return null;

        const path = [];
        let cur = toNodeId;
        while (cur !== -1) {
            path.push(this._nodes[cur]);
            cur = prev[cur];
        }
        path.reverse();

        return { path, distance: dist[toNodeId] };
    }

    getNodeCount() { return this._nodes.length; }
    getEdgeCount() { return this._adj.reduce((s, a) => s + a.length, 0) / 2; }

    _projectOntoSegment(px, py, ax, ay, bx, by) {
        const abx = bx - ax, aby = by - ay;
        const apx = px - ax, apy = py - ay;
        const ab2 = abx * abx + aby * aby;
        if (ab2 < 0.001) {
            const d = Math.sqrt(apx * apx + apy * apy);
            return { x: ax, y: ay, dist: d };
        }
        let t = (apx * abx + apy * aby) / ab2;
        t = Math.max(0, Math.min(1, t));
        const projX = ax + t * abx;
        const projY = ay + t * aby;
        const dx = px - projX, dy = py - projY;
        return { x: projX, y: projY, dist: Math.sqrt(dx * dx + dy * dy) };
    }
}

class MinHeap {
    constructor() { this._data = []; }

    push(id, priority) {
        this._data.push({ id, priority });
        this._bubbleUp(this._data.length - 1);
    }

    pop() {
        const top = this._data[0];
        const last = this._data.pop();
        if (this._data.length > 0) {
            this._data[0] = last;
            this._sinkDown(0);
        }
        return top;
    }

    size() { return this._data.length; }

    _bubbleUp(i) {
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this._data[i].priority >= this._data[parent].priority) break;
            [this._data[i], this._data[parent]] = [this._data[parent], this._data[i]];
            i = parent;
        }
    }

    _sinkDown(i) {
        const n = this._data.length;
        while (true) {
            let smallest = i;
            const l = 2 * i + 1, r = 2 * i + 2;
            if (l < n && this._data[l].priority < this._data[smallest].priority) smallest = l;
            if (r < n && this._data[r].priority < this._data[smallest].priority) smallest = r;
            if (smallest === i) break;
            [this._data[i], this._data[smallest]] = [this._data[smallest], this._data[i]];
            i = smallest;
        }
    }
}
