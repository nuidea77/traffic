/**
 * router.js — Түгжрэлийн түвшнээс хамаарсан жинтэй A* маршрут хайлт.
 *
 * Гол санаа: түгжрэлтэй үед гол зам (trunk/primary/secondary) маш удаан
 * болдог бол гэр хороолол, хорооллын доторх жижиг замууд (residential,
 * service, unclassified, track) харьцангуй хэвийн хурдтай үлддэг.
 * Тиймээс ирмэг бүрийн туулах хугацааг замын ангилал × түгжрэлийн
 * коэффициентээр тооцвол A* өөрөө жижиг замаар тойрсон хамгийн хурдан
 * маршрутыг олно.
 */

// Чөлөөтэй үеийн бодит дундаж хурд, км/ц
const BASE_SPEED = {
  motorway: 70, motorway_link: 45,
  trunk: 60, trunk_link: 40,
  primary: 50, primary_link: 35,
  secondary: 45, secondary_link: 30,
  tertiary: 40, tertiary_link: 30,
  unclassified: 30,
  residential: 25,
  living_street: 15,
  service: 18,
  track: 15,
};

// Замын ангиллын бүлэг: түгжрэл гол төлөв major замууд дээр үүсдэг.
const ROAD_CLASS = {
  motorway: "major", motorway_link: "major",
  trunk: "major", trunk_link: "major",
  primary: "major", primary_link: "major",
  secondary: "mid", secondary_link: "mid",
  tertiary: "mid", tertiary_link: "mid",
  unclassified: "minor",
  residential: "minor",
  living_street: "minor",
  service: "minor",
  track: "minor",
};

// Гараар сонгох түвшин бүрийн хурдны коэффициент — AI загвар
// ачаалагдаагүй эсвэл хэрэглэгч түвшнээ өөрөө сонгосон үеийн fallback.
// jam үед гол зам 18% хурдтай (50 → ~9 км/ц мөлхөнө) байхад
// хорооллын жижиг зам 75%-даа (25 → ~19 км/ц) явсаар байдаг.
const CONGESTION = {
  free:   { major: 1.0,  mid: 1.0,  minor: 1.0  },
  normal: { major: 0.75, mid: 0.85, minor: 0.95 },
  busy:   { major: 0.4,  mid: 0.6,  minor: 0.85 },
  jam:    { major: 0.18, mid: 0.35, minor: 0.75 },
};

// Уулзвар/эргэлт бүрийн дундаж саатал (сек) — жижиг замаар зигзаг
// хийхийн бодит өртгийг тусгана. Түгжрэлтэй үед уулзвар гарахад удаан.
const JUNCTION_PENALTY = { free: 3, normal: 4, busy: 6, jam: 8 };

const MAX_SPEED_MS = (70 * 1000) / 3600; // heuristic-д ашиглах дээд хурд

/** Гараар сонгосон түвшнийг коэффициентийн объект болгоно. */
function levelFactors(level) {
  return { ...CONGESTION[level], junctionPenalty: JUNCTION_PENALTY[level] };
}

/** Ирмэгийн бодит хурд, м/с. factors = {major, mid, minor, junctionPenalty} */
function edgeSpeed(edge, factors) {
  const base = BASE_SPEED[edge.highway] || 20;
  const cls = ROAD_CLASS[edge.highway] || "minor";
  let speed = base * factors[cls];
  // Гэр хорооллын шороон зам: хуурай үед ч удаан тул хурдыг бууруулна.
  if (/^(unpaved|dirt|ground|gravel|earth|sand|mud)/.test(edge.surface)) {
    speed *= 0.7;
  }
  return Math.max((speed * 1000) / 3600, 0.5);
}

/** Ирмэгийг туулах хугацаа, сек */
function edgeTime(edge, factors) {
  return edge.dist / edgeSpeed(edge, factors) + factors.junctionPenalty;
}

/** Хоёртын min-heap — том граф дээр хурдан ажиллуулахад хэрэгтэй. */
class MinHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(item) {
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.items[p].f <= this.items[i].f) break;
      [this.items[p], this.items[i]] = [this.items[i], this.items[p]];
      i = p;
    }
  }
  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let m = i;
        if (l < this.items.length && this.items[l].f < this.items[m].f) m = l;
        if (r < this.items.length && this.items[r].f < this.items[m].f) m = r;
        if (m === i) break;
        [this.items[m], this.items[i]] = [this.items[i], this.items[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * A* хайлт. Амжилттай бол маршрутын геометр, нийт зай/хугацаа,
 * замын ангиллаар задалсан статистикийг буцаана.
 */
function findRoute(graph, startId, endId, factors) {
  const endNode = graph.nodes.get(endId);
  const heuristic = (id) => {
    const n = graph.nodes.get(id);
    return haversine(n.lat, n.lon, endNode.lat, endNode.lon) / MAX_SPEED_MS;
  };

  const gScore = new Map([[startId, 0]]);
  const cameFrom = new Map(); // nodeId -> { prev, edge }
  const closed = new Set();
  const heap = new MinHeap();
  heap.push({ id: startId, f: heuristic(startId) });

  while (heap.size > 0) {
    const { id: current } = heap.pop();
    if (current === endId) return reconstruct(cameFrom, endId, factors);
    if (closed.has(current)) continue;
    closed.add(current);

    for (const edge of graph.adj.get(current) || []) {
      if (closed.has(edge.to)) continue;
      const tentative = gScore.get(current) + edgeTime(edge, factors);
      if (tentative < (gScore.get(edge.to) ?? Infinity)) {
        gScore.set(edge.to, tentative);
        cameFrom.set(edge.to, { prev: current, edge });
        heap.push({ id: edge.to, f: tentative + heuristic(edge.to) });
      }
    }
  }
  return null; // зам олдсонгүй
}

function reconstruct(cameFrom, endId, factors) {
  const edges = [];
  let cur = endId;
  while (cameFrom.has(cur)) {
    const { prev, edge } = cameFrom.get(cur);
    edges.push(edge);
    cur = prev;
  }
  edges.reverse();

  const geometry = [];
  let totalDist = 0;
  let totalTime = 0;
  const byClass = { major: 0, mid: 0, minor: 0 }; // метрээр

  for (const edge of edges) {
    totalDist += edge.dist;
    totalTime += edgeTime(edge, factors);
    byClass[ROAD_CLASS[edge.highway] || "minor"] += edge.dist;
    const pts = geometry.length > 0 ? edge.geometry.slice(1) : edge.geometry;
    geometry.push(...pts);
  }

  return { geometry, totalDist, totalTime, byClass, edges };
}

/** Өгсөн маршрутыг өөр түгжрэлийн түвшинд явбал хэдэн секунд болохыг тооцно. */
function timeWithFactors(edges, factors) {
  let t = 0;
  for (const edge of edges) t += edgeTime(edge, factors);
  return t;
}
