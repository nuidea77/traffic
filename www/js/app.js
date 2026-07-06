/**
 * app.js — газрын зураг, хэрэглэгчийн интерфэйс, маршрутын харьцуулалт.
 *
 * Хоёр маршрут зэрэг харуулна:
 *   1. Ухаалаг маршрут — одоогийн түгжрэлийн жингээр A* (түгжрэлтэй үед
 *      гэр хороолол/жижиг замаар тойрно).
 *   2. Гол замын маршрут — чөлөөт үеийн жингээр олдсон "энгийн" маршрут.
 *      Хоёуланг нь одоогийн түгжрэлээр хэдэн минут явахыг тооцож
 *      харьцуулснаар хэмнэсэн хугацаа харагдана.
 */

const UB_CENTER = [47.9188, 106.9176];
const UB_VIEWBOX = "106.55,48.10,107.25,47.75"; // Nominatim хайлтын хүрээ
const MAX_BBOX_SPAN_KM = 28; // Overpass-д хэт том талбай татахаас хамгаална

const map = L.map("map").setView(UB_CENTER, 12);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const state = {
  start: null, // L.Marker
  end: null,
  level: "auto",
  graph: null,
  graphKey: null,
  smartLine: null,
  mainLine: null,
  routing: false,
};

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

/* ---------- Түгжрэлийн түвшин ---------- */

/** Улаанбаатарын цагаар оргил ачааллын үеийг тодорхойлно. */
function autoTrafficLevel() {
  const now = new Date();
  const ub = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Ulaanbaatar" }));
  const day = ub.getDay(); // 0 = Ням
  const h = ub.getHours() + ub.getMinutes() / 60;
  const weekend = day === 0 || day === 6;

  if (!weekend) {
    if ((h >= 7.5 && h < 10) || (h >= 16.5 && h < 20)) return "jam";
    if ((h >= 6.5 && h < 7.5) || (h >= 10 && h < 16.5) || (h >= 20 && h < 21)) return "busy";
    if (h >= 21 || h < 6) return "free";
    return "normal";
  }
  if (h >= 11 && h < 19) return "busy";
  if (h >= 8 && h < 11) return "normal";
  return "free";
}

const LEVEL_NAMES = {
  free: "🟢 Чөлөөтэй",
  normal: "🟡 Хэвийн",
  busy: "🟠 Ачаалалтай",
  jam: "🔴 Түгжрэлтэй",
};

function effectiveLevel() {
  return state.level === "auto" ? autoTrafficLevel() : state.level;
}

function updateAutoInfo() {
  const info = $("auto-level-info");
  if (state.level === "auto") {
    info.textContent = `Одоо УБ-д: ${LEVEL_NAMES[autoTrafficLevel()]} гэж тооцож байна.`;
  } else {
    info.textContent = "";
  }
}

document.querySelectorAll(".level-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".level-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.level = btn.dataset.level;
    updateAutoInfo();
    if (state.start && state.end && state.graph) calcRoute();
  });
});
updateAutoInfo();
setInterval(updateAutoInfo, 60000);

/* ---------- Цэг сонгох ---------- */

const startIcon = L.divIcon({
  className: "",
  html: '<div style="width:18px;height:18px;border-radius:50%;background:#2ecc71;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});
const endIcon = L.divIcon({
  className: "",
  html: '<div style="width:18px;height:18px;border-radius:50%;background:#e74c3c;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

function setPoint(which, latlng) {
  const icon = which === "start" ? startIcon : endIcon;
  if (state[which]) {
    state[which].setLatLng(latlng);
  } else {
    state[which] = L.marker(latlng, { icon, draggable: true }).addTo(map);
    state[which].on("dragend", () => {
      if (state.start && state.end) calcRoute();
    });
  }
  updateRouteBtn();
}

map.on("click", (e) => {
  if (!state.start) setPoint("start", e.latlng);
  else if (!state.end) setPoint("end", e.latlng);
  else setPoint("end", e.latlng); // дараагийн даралт очих цэгийг шинэчилнэ
});

function updateRouteBtn() {
  $("route-btn").disabled = !(state.start && state.end) || state.routing;
}

$("clear-btn").addEventListener("click", () => {
  for (const key of ["start", "end"]) {
    if (state[key]) { map.removeLayer(state[key]); state[key] = null; }
  }
  clearRoutes();
  $("results").classList.add("hidden");
  setStatus("");
  updateRouteBtn();
});

function clearRoutes() {
  for (const key of ["smartLine", "mainLine"]) {
    if (state[key]) { map.removeLayer(state[key]); state[key] = null; }
  }
}

/* ---------- Миний байршил (GPS) ---------- */

/** Нэйтив апп дотор Capacitor Geolocation, хөтөч дээр navigator.geolocation ашиглана. */
async function getCurrentPosition() {
  const cap = window.Capacitor?.Plugins?.Geolocation;
  if (cap) {
    const pos = await cap.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
    return { lat: pos.coords.latitude, lng: pos.coords.longitude };
  }
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Байршил тогтоох боломжгүй төхөөрөмж"));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error("Байршил авч чадсангүй: " + err.message)),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });
}

$("locate-btn").addEventListener("click", async () => {
  setStatus("Байршил тогтоож байна…");
  try {
    const { lat, lng } = await getCurrentPosition();
    const latlng = L.latLng(lat, lng);
    setPoint("start", latlng);
    map.setView(latlng, 15);
    setStatus("");
    if (state.end) calcRoute();
  } catch (err) {
    setStatus(err.message, true);
  }
});

/* ---------- Хаягийн хайлт (Nominatim) ---------- */

async function geocode(query, which) {
  const resultsEl = $("search-results");
  resultsEl.innerHTML = "";
  if (!query.trim()) return;
  setStatus("Хайж байна…");
  try {
    const url =
      "https://nominatim.openstreetmap.org/search?format=json&limit=5" +
      `&viewbox=${UB_VIEWBOX}&bounded=1&accept-language=mn` +
      `&q=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    const items = await res.json();
    setStatus("");
    if (items.length === 0) {
      setStatus("Хайлтад илэрц олдсонгүй", true);
      return;
    }
    for (const item of items) {
      const btn = document.createElement("button");
      btn.className = "search-result";
      btn.textContent = (which === "start" ? "🟢 " : "🔴 ") + item.display_name;
      btn.addEventListener("click", () => {
        const latlng = L.latLng(+item.lat, +item.lon);
        setPoint(which, latlng);
        map.panTo(latlng);
        resultsEl.innerHTML = "";
      });
      resultsEl.appendChild(btn);
    }
  } catch (err) {
    setStatus("Хайлт амжилтгүй: " + err.message, true);
  }
}

$("start-search").addEventListener("click", () => geocode($("start-input").value, "start"));
$("end-search").addEventListener("click", () => geocode($("end-input").value, "end"));
$("start-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") geocode(e.target.value, "start");
});
$("end-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") geocode(e.target.value, "end");
});

/* ---------- Маршрут тооцоолол ---------- */

function fmtTime(sec) {
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} мин`;
  return `${Math.floor(min / 60)} ц ${min % 60} мин`;
}

function fmtDist(m) {
  return m < 1000 ? `${Math.round(m)} м` : `${(m / 1000).toFixed(1)} км`;
}

function breakdownHtml(byClass, totalDist) {
  const pct = (x) => Math.round((x / totalDist) * 100);
  return (
    `Гол зам: ${fmtDist(byClass.major)} (${pct(byClass.major)}%) · ` +
    `Дунд зам: ${fmtDist(byClass.mid)} (${pct(byClass.mid)}%) · ` +
    `Жижиг/хорооллын зам: <b>${fmtDist(byClass.minor)} (${pct(byClass.minor)}%)</b>`
  );
}

async function ensureGraph() {
  const bbox = computeBBox(state.start.getLatLng(), state.end.getLatLng());
  const spanKm = haversine(bbox.south, bbox.west, bbox.north, bbox.east) / 1000;
  if (spanKm > MAX_BBOX_SPAN_KM) {
    throw new Error(
      "Хоёр цэгийн хоорондох зай хэт их байна. Хот доторх богино маршрут сонгоно уу."
    );
  }
  const key = bboxKey(bbox);
  if (state.graphKey === key && state.graph) return state.graph;

  const ways = await fetchRoads(bbox, setStatus);
  setStatus(`Граф байгуулж байна… (${ways.length} зам)`);
  await new Promise((r) => setTimeout(r, 10)); // UI шинэчлэгдэх зай
  const graph = buildGraph(ways);
  if (graph.nodes.size === 0) throw new Error("Энэ хэсэгт замын өгөгдөл олдсонгүй");

  state.graph = graph;
  state.graphKey = key;
  return graph;
}

async function calcRoute() {
  if (state.routing || !state.start || !state.end) return;
  state.routing = true;
  updateRouteBtn();
  clearRoutes();
  $("results").classList.add("hidden");

  try {
    const graph = await ensureGraph();
    const level = effectiveLevel();
    setStatus(`Маршрут тооцоолж байна… (${LEVEL_NAMES[level]})`);
    await new Promise((r) => setTimeout(r, 10));

    const s = state.start.getLatLng();
    const e = state.end.getLatLng();
    const startNode = nearestNode(graph, s.lat, s.lng);
    const endNode = nearestNode(graph, e.lat, e.lng);
    if (!startNode.id || !endNode.id) throw new Error("Ойролцоо зам олдсонгүй");
    if (startNode.dist > 1500 || endNode.dist > 1500) {
      throw new Error("Сонгосон цэг замаас хэт хол байна (>1.5 км)");
    }

    // 1. Түгжрэл тооцсон ухаалаг маршрут
    const smart = findRoute(graph, startNode.id, endNode.id, level);
    if (!smart) throw new Error("Хоёр цэгийг холбох зам олдсонгүй");

    // 2. Чөлөөт үеийн (гол замын) маршрут — одоогийн түгжрэлээр хэр удаан
    //    явахыг нь тооцож харьцуулна.
    const main = findRoute(graph, startNode.id, endNode.id, "free");
    const mainTimeNow = timeAtLevel(main.edges, level);

    drawResults(smart, main, mainTimeNow, level);
    setStatus("");
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    state.routing = false;
    updateRouteBtn();
  }
}

function drawResults(smart, main, mainTimeNow, level) {
  // Гол замын маршрутыг доор нь бүдэг зурна
  state.mainLine = L.polyline(main.geometry, {
    color: "#7f8fa6",
    weight: 5,
    opacity: 0.75,
    dashArray: "8 8",
  }).addTo(map);

  state.smartLine = L.polyline(smart.geometry, {
    color: "#2ecc71",
    weight: 6,
    opacity: 0.95,
  }).addTo(map);

  map.fitBounds(state.smartLine.getBounds().extend(state.mainLine.getBounds()), {
    padding: [40, 40],
  });

  $("smart-time").textContent = fmtTime(smart.totalTime);
  $("smart-dist").textContent = fmtDist(smart.totalDist);
  $("smart-breakdown").innerHTML = breakdownHtml(smart.byClass, smart.totalDist);

  $("main-time").textContent = fmtTime(mainTimeNow);
  $("main-dist").textContent = fmtDist(main.totalDist);
  $("main-breakdown").innerHTML = breakdownHtml(main.byClass, main.totalDist);

  const savedMin = Math.round((mainTimeNow - smart.totalTime) / 60);
  const savingsEl = $("savings");
  if (savedMin >= 1) {
    savingsEl.textContent = `✨ Жижиг замаар тойрсноор ~${savedMin} минут хэмнэнэ (${LEVEL_NAMES[level]})`;
  } else if (level === "free" || level === "normal") {
    savingsEl.textContent = "Одоо түгжрэл багатай тул гол замаар явахад хангалттай хурдан.";
  } else {
    savingsEl.textContent = "Энэ чиглэлд гол зам одоо ч хамгийн хурдан хувилбар байна.";
  }

  $("results").classList.remove("hidden");
}

$("route-btn").addEventListener("click", calcRoute);
