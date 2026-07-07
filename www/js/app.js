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

const map = L.map("map", { zoomControl: false }).setView(UB_CENTER, 12);
L.control.zoom({ position: "bottomright" }).addTo(map);
// Дизайнд тохирсон харанхуй суурь зураг (CARTO dark)
L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  maxZoom: 19,
  subdomains: "abcd",
  attribution:
    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>',
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

/** Улаанбаатарын цагаар гараг/цагийг гаргана (AI загварын оролт). */
function ubNow() {
  const ub = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ulaanbaatar" }));
  return { dow: ub.getDay(), hour: ub.getHours() + ub.getMinutes() / 60 };
}

/** AI загваргүй үеийн fallback: цагийн хуваарьт суурилсан түвшин. */
function autoTrafficLevel() {
  const { dow, hour: h } = ubNow();
  const weekend = dow === 0 || dow === 6;

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
  free: "Чөлөөтэй",
  normal: "Хэвийн",
  busy: "Ачаалалтай",
  jam: "Түгжрэлтэй",
};

/**
 * Маршрут бодоход ашиглах коэффициентүүд.
 * auto горимд AI загвар одоогийн гараг/цагаас таамаглана;
 * загвар ачаалагдаагүй бол цагийн хуваарийн fallback,
 * гараар сонгосон бол тухайн түвшний тогтмол коэффициент.
 */
function effectiveFactors() {
  if (state.level === "auto" && TrafficModel.ready) {
    const { dow, hour } = ubNow();
    return { factors: TrafficModel.predictFactors(dow, hour), label: "AI таамаглал" };
  }
  const level = state.level === "auto" ? autoTrafficLevel() : state.level;
  return { factors: levelFactors(level), label: LEVEL_NAMES[level] };
}

function updateAutoInfo() {
  const info = $("auto-level-info");
  if (state.level !== "auto") {
    info.textContent = "";
    return;
  }
  if (TrafficModel.ready) {
    const { dow, hour } = ubNow();
    const f = TrafficModel.predictFactors(dow, hour);
    const pct = (x) => Math.round(x * 100);
    info.textContent =
      `AI: одоо гол зам ${pct(f.major)}%, дунд зам ${pct(f.mid)}%, ` +
      `хорооллын зам ${pct(f.minor)}% хурдтай гэж таамаглаж байна.`;
  } else {
    info.textContent = `Одоо УБ-д: ${LEVEL_NAMES[autoTrafficLevel()]} гэж тооцож байна.`;
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

// Дизайны дагуу хоёр төгсгөл хоёулаа гэрэлтдэг неон цэг
const neonIcon = () =>
  L.divIcon({
    className: "",
    html: '<div class="neon-dot"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
const startIcon = neonIcon();
const endIcon = neonIcon();

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
  for (const key of ["smartLine", "smartGlow", "smartGlowWide", "mainLine", "routeTip"]) {
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
      const icon = document.createElement("i");
      icon.className = which === "start"
        ? "fa-solid fa-circle-dot result-start"
        : "fa-solid fa-location-dot result-end";
      btn.appendChild(icon);
      btn.appendChild(document.createTextNode(" " + item.display_name));
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

async function ensureGraph(expand = 1) {
  const s = state.start.getLatLng();
  const e = state.end.getLatLng();
  // Зайнаас хамаарч шатлал сонгоно: богино бол бүх зам, урт бол
  // корридорт гол замууд + захын цэгүүдийн орчимд бүх зам
  const plan = routePlan(s, e, expand);
  if (state.graphKey === plan.key && state.graph) return state.graph;

  const ways = await fetchRoadsForPlan(plan, s, e, setStatus);
  setStatus(`Граф байгуулж байна… (${ways.length} зам)`);
  await new Promise((r) => setTimeout(r, 10)); // UI шинэчлэгдэх зай
  const graph = buildGraph(ways);
  if (graph.nodes.size === 0) throw new Error("Энэ хэсэгт замын өгөгдөл олдсонгүй");

  state.graph = graph;
  state.graphKey = plan.key;
  return graph;
}

async function calcRoute() {
  if (state.routing || !state.start || !state.end) return;
  state.routing = true;
  updateRouteBtn();
  clearRoutes();
  $("results").classList.add("hidden");

  try {
    const { factors, label } = effectiveFactors();
    const s = state.start.getLatLng();
    const e = state.end.getLatLng();

    // Бодит зам (уул, гол тойрдог) bbox-оос гадуур гарсан байж болзошгүй
    // тул зам олдоогүй үед хайлтын хүрээг шатлан тэлж дахин оролдоно.
    let smart = null;
    let graph = null;
    let startNode, endNode;
    for (const expand of [1, 2.5, 5]) {
      graph = await ensureGraph(expand);
      setStatus(`Маршрут тооцоолж байна… (${label})`);
      await new Promise((r) => setTimeout(r, 10));

      startNode = nearestNode(graph, s.lat, s.lng);
      endNode = nearestNode(graph, e.lat, e.lng);
      if (!startNode.id || !endNode.id) throw new Error("Ойролцоо зам олдсонгүй");
      if (startNode.dist > 1500 || endNode.dist > 1500) {
        throw new Error("Сонгосон цэг замаас хэт хол байна (>1.5 км)");
      }

      smart = findRoute(graph, startNode.id, endNode.id, factors);
      if (smart) break;
      setStatus("Зам олдсонгүй — хайлтын хүрээг тэлж байна…");
    }
    if (!smart) throw new Error("Хоёр цэгийг холбох зам олдсонгүй");

    // Чөлөөт үеийн (гол замын) маршрут — одоогийн түгжрэлээр хэр удаан
    // явахыг нь тооцож харьцуулна.
    const main = findRoute(graph, startNode.id, endNode.id, levelFactors("free"));
    const mainTimeNow = timeWithFactors(main.edges, factors);

    drawResults(smart, main, mainTimeNow, factors, label);
    setStatus("");
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    state.routing = false;
    updateRouteBtn();
  }
}

function drawResults(smart, main, mainTimeNow, factors, label) {
  // Гол замын маршрутыг доор нь бүдэг тасархайгаар зурна
  state.mainLine = L.polyline(main.geometry, {
    color: "#8a8a93",
    weight: 4,
    opacity: 0.55,
    dashArray: "6 10",
  }).addTo(map);

  // Ухаалаг маршрут: неон шар, гэрэлтэлтийг давхар зузаан шугамаар үүсгэнэ
  const NEON = "#dcf548";
  state.smartGlowWide = L.polyline(smart.geometry, {
    color: NEON, weight: 22, opacity: 0.1, interactive: false,
  }).addTo(map);
  state.smartGlow = L.polyline(smart.geometry, {
    color: NEON, weight: 11, opacity: 0.28, interactive: false,
  }).addTo(map);
  state.smartLine = L.polyline(smart.geometry, {
    color: NEON, weight: 4.5, opacity: 1,
  }).addTo(map);

  // Маршрутын дунд цэг дээр хугацаа/зайн tooltip
  const midPt = smart.geometry[Math.floor(smart.geometry.length / 2)];
  state.routeTip = L.marker(midPt, {
    interactive: false,
    icon: L.divIcon({
      className: "",
      html: `<div class="route-tip">${fmtTime(smart.totalTime)} · ${fmtDist(smart.totalDist)}</div>`,
      iconSize: [0, 0],
    }),
  }).addTo(map);

  map.fitBounds(state.smartLine.getBounds().extend(state.mainLine.getBounds()), {
    paddingTopLeft: [50, 260],
    paddingBottomRight: [50, 170],
  });

  $("smart-time").textContent = fmtTime(smart.totalTime);
  $("smart-dist").textContent = fmtDist(smart.totalDist);
  $("smart-breakdown").innerHTML = breakdownHtml(smart.byClass, smart.totalDist);

  $("main-time").textContent = fmtTime(mainTimeNow);
  $("main-dist").textContent = fmtDist(main.totalDist);
  $("main-breakdown").innerHTML = breakdownHtml(main.byClass, main.totalDist);

  const savedMin = Math.round((mainTimeNow - smart.totalTime) / 60);
  $("saved-min").textContent = savedMin >= 1 ? `~${savedMin} мин` : "—";
  const savingsEl = $("savings");
  if (savedMin >= 1) {
    savingsEl.textContent = `Жижиг замаар тойрсноор ~${savedMin} минут хэмнэнэ (${label})`;
  } else if (factors.major >= 0.7) {
    savingsEl.textContent = "Одоо түгжрэл багатай тул гол замаар явахад хангалттай хурдан.";
  } else {
    savingsEl.textContent = "Энэ чиглэлд гол зам одоо ч хамгийн хурдан хувилбар байна.";
  }

  $("results").classList.remove("hidden");
}

// Картын ↗ товч дэлгэрэнгүйг нээж хаана
$("card-toggle").addEventListener("click", () => {
  $("card-details").classList.toggle("hidden");
  $("card-toggle").classList.toggle("open");
});

$("route-btn").addEventListener("click", calcRoute);

/* ---------- AI загвар ба бодит өгөгдөл цуглуулалт ---------- */

function updateCollectInfo() {
  const n = Calibration.sampleCount();
  $("collect-info").textContent =
    n > 0
      ? `Цуглуулсан хэмжилт: ${n}. Экспортолж ml/data/-д хийгээд train.py ажиллуулбал загвар сайжирна.`
      : "Жолоодох үедээ хэмжилт эхлүүлбэл апп таны явдаг замын бодит хурдыг сурна.";
}

TrafficModel.load()
  .then((meta) => {
    $("model-status").textContent =
      `Идэвхтэй — ${meta.n_samples.toLocaleString()} хэмжилтээр сургасан, ` +
      `алдаа (RMSE) ±${Math.round(meta.val_rmse * 100)}%. ` +
      `Гараг, цагаас замын ангилал бүрийн хурдыг таамаглана.`;
    updateAutoInfo();
  })
  .catch((err) => {
    $("model-status").textContent =
      `Загвар ачаалагдсангүй (${err.message}) — цагийн хуваарийн fallback ашиглана.`;
  });
updateCollectInfo();

/* Жолоодлогын горим: GPS-ээр бодит хурд хэмжиж, ойролцоох замын
   ангилалтай харьцуулан speed_ratio хэмжилт цуглуулна. */
const drive = { watchId: null, capWatchId: null, lastSample: 0 };

function handlePosition(coords) {
  const now = Date.now();
  if (now - drive.lastSample < 5000) return; // 5 сек тутам дээж
  if (coords.speed == null || coords.accuracy > 40) return;

  const graph = state.graph;
  if (!graph) return;
  const near = nearestNode(graph, coords.latitude, coords.longitude);
  if (!near.id || near.dist > 60) return; // граф доторх замаас хол

  // Тухайн уулзварын ирмэгүүдээс замын ангиллыг тогтооно
  const edges = graph.adj.get(near.id) || [];
  if (edges.length === 0) return;
  const edge = edges[0];
  const cls = ROAD_CLASS[edge.highway] || "minor";
  const freeMs = ((BASE_SPEED[edge.highway] || 20) * 1000) / 3600;
  const ratio = Math.min(Math.max(coords.speed / freeMs, 0.05), 1);

  const { dow, hour } = ubNow();
  Calibration.addSample(cls, dow, hour, ratio);
  drive.lastSample = now;
  updateCollectInfo();
}

async function startDrive() {
  const cap = window.Capacitor?.Plugins?.Geolocation;
  if (cap) {
    drive.capWatchId = await cap.watchPosition(
      { enableHighAccuracy: true },
      (pos, err) => { if (pos) handlePosition(pos.coords); }
    );
  } else if (navigator.geolocation) {
    drive.watchId = navigator.geolocation.watchPosition(
      (pos) => handlePosition(pos.coords),
      () => setStatus("GPS хэмжилт авч чадсангүй", true),
      { enableHighAccuracy: true }
    );
  } else {
    throw new Error("Байршил тогтоох боломжгүй төхөөрөмж");
  }
}

function stopDrive() {
  const cap = window.Capacitor?.Plugins?.Geolocation;
  if (drive.capWatchId != null) cap?.clearWatch({ id: drive.capWatchId });
  if (drive.watchId != null) navigator.geolocation.clearWatch(drive.watchId);
  drive.capWatchId = drive.watchId = null;
}

$("drive-btn").addEventListener("click", async () => {
  const btn = $("drive-btn");
  if (drive.watchId != null || drive.capWatchId != null) {
    stopDrive();
    btn.innerHTML = '<i class="fa-solid fa-car-side"></i> Хэмжилт эхлүүлэх';
    btn.classList.remove("active");
    return;
  }
  if (!state.graph) {
    setStatus("Эхлээд маршрут гаргавал зам таних граф ачаалагдана", true);
    return;
  }
  try {
    await startDrive();
    btn.innerHTML = '<i class="fa-solid fa-stop"></i> Хэмжилт зогсоох';
    btn.classList.add("active");
    setStatus("");
  } catch (err) {
    setStatus(err.message, true);
  }
});

$("export-btn").addEventListener("click", () => {
  if (Calibration.sampleCount() === 0) {
    setStatus("Экспортлох хэмжилт алга — эхлээд жолоодлогын горимоор цуглуул", true);
    return;
  }
  const blob = new Blob([Calibration.exportCsv()], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "collected_traffic.csv";
  a.click();
  URL.revokeObjectURL(a.href);
});
