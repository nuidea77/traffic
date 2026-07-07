/**
 * graph.js — OpenStreetMap-аас (Overpass API) замын сүлжээ татаж,
 * маршрут тооцоолоход зориулсан граф байгуулна.
 *
 * Граф бүтэц:
 *   nodes: Map<nodeId, {lat, lon}>
 *   adj:   Map<nodeId, Array<Edge>>
 *   Edge:  { to, dist (м), highway, surface, geometry: [[lat,lon], ...] }
 */

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// Машинаар явж болох замын төрлүүд. Гэр хорооллын жижиг замууд ихэвчлэн
// residential / unclassified / service / track гэж тэмдэглэгдсэн байдаг.
const ROUTABLE_HIGHWAYS =
  "motorway|trunk|primary|secondary|tertiary|unclassified|residential|" +
  "living_street|service|track|motorway_link|trunk_link|primary_link|" +
  "secondary_link|tertiary_link";

// Урт маршрутын дундах хэсэгт татах томоохон замууд — bbox том байхад
// бүх жижиг замыг татвал хэт их өгөгдөл болдог тул шатлан хязгаарлана.
const ARTERIAL_HIGHWAYS =
  "motorway|trunk|primary|secondary|tertiary|unclassified|" +
  "motorway_link|trunk_link|primary_link|secondary_link|tertiary_link";
const TRUNK_HIGHWAYS =
  "motorway|trunk|primary|secondary|" +
  "motorway_link|trunk_link|primary_link|secondary_link";

// Диагональ хэмжээгээр шатлал сонгоно (км)
const DETAIL_SPAN_KM = 30;   // бүх замыг бүтэн хүрээгээр
const ARTERIAL_SPAN_KM = 160; // корридорт arterial, захад бүх зам
const MAX_SPAN_KM = 700;     // trunk корридор — үүнээс хэтэрвэл алдаа
const ENDPOINT_DETAIL_M = 3000; // захын цэг орчмын дэлгэрэнгүй радиус

const EARTH_R = 6371000;

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

/**
 * Эхлэх/очих цэгийг багтаасан, захаасаа нэмэлт зайтай bbox гаргана.
 * Хоёр цэг нэг шулуун дээр ойрхон байхад bbox хэт нарийсдаг тул хоёр
 * тэнхлэгийг хоёр цэгийн шууд зайд (диагональд) пропорциональ тэлнэ —
 * бодит зам ууль/гол тойрч алсуур гарах тохиолдлыг багтаахад чухал.
 * expand нь зам олдоогүй үед хүрээг дахин тэлэх коэффициент.
 */
function computeBBox(a, b, padRatio = 0.35, minPadMeters = 1200, expand = 1) {
  let south = Math.min(a.lat, b.lat);
  let north = Math.max(a.lat, b.lat);
  let west = Math.min(a.lng, b.lng);
  let east = Math.max(a.lng, b.lng);

  const directM = haversine(a.lat, a.lng, b.lat, b.lng);
  const basePadM = Math.max(directM * 0.22 * expand, minPadMeters);

  const midLat = (south + north) / 2;
  const latPad = Math.max((north - south) * padRatio, basePadM / 111320);
  const lonPad = Math.max(
    (east - west) * padRatio,
    basePadM / (111320 * Math.cos((midLat * Math.PI) / 180))
  );
  return {
    south: south - latPad,
    west: west - lonPad,
    north: north + latPad,
    east: east + lonPad,
  };
}

function bboxKey(bbox) {
  const r = (x) => x.toFixed(3);
  return `${r(bbox.south)},${r(bbox.west)},${r(bbox.north)},${r(bbox.east)}`;
}

/** bbox доторх өгсөн төрлийн машины замуудыг Overpass-аас татна. */
async function fetchRoads(bbox, onProgress, highways = ROUTABLE_HIGHWAYS) {
  const q = `[out:json][timeout:120];
way["highway"~"^(${highways})$"]
  ["access"!~"^(private|no)$"]
  ["motor_vehicle"!~"^(private|no)$"]
  (${bbox.south},${bbox.west},${bbox.north},${bbox.east});
out geom;`;

  let lastErr = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      onProgress?.(`Замын өгөгдөл татаж байна… (${new URL(endpoint).host})`);
      const res = await fetch(endpoint, {
        method: "POST",
        body: "data=" + encodeURIComponent(q),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        // Гацсан mirror дээр удаан хүлээлгүй дараагийнх руу шилжинэ
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.elements) throw new Error("Хоосон хариу ирлээ");
      return data.elements.filter((e) => e.type === "way" && e.geometry);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Замын өгөгдөл татаж чадсангүй (${lastErr?.message || "тодорхойгүй алдаа"})`
  );
}

/**
 * Хоёр цэгийн зайнаас хамаарч татах стратеги (шатлал) сонгоно.
 * Богино маршрутад бүх замыг, урт маршрутад дундах корридорт зөвхөн
 * томоохон замуудыг, харин эхлэх/очих цэгийн орчимд бүх замыг татна —
 * ингэснээр гэр хорооллоос гарах/орох хэсэг дэлгэрэнгүй хэвээр үлдэнэ.
 */
function routePlan(a, b, expand = 1) {
  const directKm = haversine(a.lat, a.lng, b.lat, b.lng) / 1000;
  if (directKm > MAX_SPAN_KM) {
    throw new Error(`Хоёр цэг хэт хол байна (${Math.round(directKm)} км > ${MAX_SPAN_KM} км)`);
  }
  const bbox = computeBBox(a, b, 0.35, 1200, expand);
  const spanKm = haversine(bbox.south, bbox.west, bbox.north, bbox.east) / 1000;
  const tier =
    spanKm <= DETAIL_SPAN_KM ? "detail" : spanKm <= ARTERIAL_SPAN_KM ? "arterial" : "trunk";
  return { bbox, spanKm, tier, key: `${bboxKey(bbox)}:${tier}` };
}

/** routePlan-ий дагуу замуудыг татаж нэгтгэнэ (way id-гаар давхардлыг арилгана). */
async function fetchRoadsForPlan(plan, a, b, onProgress) {
  if (plan.tier === "detail") {
    return fetchRoads(plan.bbox, onProgress);
  }
  const corridorFilter = plan.tier === "arterial" ? ARTERIAL_HIGHWAYS : TRUNK_HIGHWAYS;
  onProgress?.(`Урт маршрут (${Math.round(plan.spanKm)} км): гол замын сүлжээ татаж байна…`);
  const ways = new Map();
  for (const w of await fetchRoads(plan.bbox, onProgress, corridorFilter)) {
    ways.set(w.id, w);
  }
  // Эхлэх/очих цэгийн орчимд бүх (жижиг) замыг нэмж татна
  for (const p of [a, b]) {
    const local = computeBBox(p, p, 0, ENDPOINT_DETAIL_M);
    onProgress?.("Захын цэгийн орчмын замуудыг татаж байна…");
    for (const w of await fetchRoads(local, onProgress)) ways.set(w.id, w);
  }
  return [...ways.values()];
}

/**
 * Way-нүүдээс граф байгуулна. Хоёр ба түүнээс олон way дамждаг node бүр
 * уулзвар тул тэнд way-г хувааж ирмэг (edge) үүсгэнэ.
 */
function buildGraph(ways) {
  // Node бүр хэдэн way-д орж байгааг тоолж уулзваруудыг олно.
  const usage = new Map();
  for (const way of ways) {
    for (const nodeId of way.nodes) {
      usage.set(nodeId, (usage.get(nodeId) || 0) + 1);
    }
  }

  const nodes = new Map();
  const adj = new Map();

  const addEdge = (from, to, dist, way, geometry) => {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push({
      to,
      dist,
      highway: way.tags.highway,
      surface: way.tags.surface || "",
      geometry,
    });
  };

  for (const way of ways) {
    const tags = way.tags || {};
    const oneway =
      tags.oneway === "yes" || tags.oneway === "1" || tags.junction === "roundabout";
    const reversed = tags.oneway === "-1";

    let segStartIdx = 0;
    let segDist = 0;
    for (let i = 1; i < way.nodes.length; i++) {
      const p0 = way.geometry[i - 1];
      const p1 = way.geometry[i];
      segDist += haversine(p0.lat, p0.lon, p1.lat, p1.lon);

      const isLast = i === way.nodes.length - 1;
      const isJunction = usage.get(way.nodes[i]) > 1;
      if (!isLast && !isJunction) continue;

      const fromId = way.nodes[segStartIdx];
      const toId = way.nodes[i];
      const geometry = way.geometry
        .slice(segStartIdx, i + 1)
        .map((p) => [p.lat, p.lon]);

      nodes.set(fromId, { lat: geometry[0][0], lon: geometry[0][1] });
      nodes.set(toId, {
        lat: geometry[geometry.length - 1][0],
        lon: geometry[geometry.length - 1][1],
      });

      if (segDist > 0 && fromId !== toId) {
        if (reversed) {
          addEdge(toId, fromId, segDist, way, [...geometry].reverse());
        } else {
          addEdge(fromId, toId, segDist, way, geometry);
          if (!oneway) addEdge(toId, fromId, segDist, way, [...geometry].reverse());
        }
      }

      segStartIdx = i;
      segDist = 0;
    }
  }

  return { nodes, adj };
}

/** Өгсөн цэгт хамгийн ойр, гарах ирмэгтэй node-г олно. */
function nearestNode(graph, lat, lng) {
  let best = null;
  let bestDist = Infinity;
  for (const [id, n] of graph.nodes) {
    if (!graph.adj.has(id)) continue;
    const d = haversine(lat, lng, n.lat, n.lon);
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }
  return { id: best, dist: bestDist };
}
