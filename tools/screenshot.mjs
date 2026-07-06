#!/usr/bin/env node
/**
 * Аппын скриншот авагч.
 *
 *   node tools/screenshot.mjs          — БОДИТ өгөгдөл: Улаанбаатарын жинхэнэ
 *                                        замууд (Overpass), CARTO dark tiles.
 *                                        Интернэт холболт шаардана.
 *   node tools/screenshot.mjs --demo   — Офлайн демо: синтетик grid замууд,
 *                                        placeholder tiles (сүлжээгүй орчинд).
 *
 * Шаардлага: npm i -D playwright && npx playwright install chromium
 * Үр дүн: shots/app-{real|demo}-{desktop,mobile}.png
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "www");
const demo = process.argv.includes("--demo");
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "shots");
mkdirSync(outDir, { recursive: true });

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
};

// www/-г түгээх жижиг static сервер
const server = createServer(async (req, res) => {
  try {
    const path = resolve(join(root, req.url === "/" ? "index.html" : req.url.split("?")[0]));
    if (!path.startsWith(root + sep) && path !== join(root, "index.html")) throw new Error("forbidden");
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const DARK_TILE = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
<rect width="256" height="256" fill="#1a1a1e"/>
<g stroke="#3a3a41" stroke-width="5">
  <line x1="0" y1="64" x2="256" y2="64"/><line x1="0" y1="160" x2="256" y2="160"/>
  <line x1="48" y1="0" x2="48" y2="256"/><line x1="176" y1="0" x2="176" y2="256"/>
</g>
</svg>`;

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright олдсонгүй. Суулгах: npm i -D playwright && npx playwright install chromium");
  process.exit(1);
}
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_BROWSERS_PATH ? { executablePath: "/opt/pw-browsers/chromium" } : {}
);

for (const [name, viewport] of [
  ["desktop", { width: 1600, height: 1230 }],
  ["mobile", { width: 390, height: 844 }],
]) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });

  if (demo) {
    await page.route(/cartocdn\.com|tile\.openstreetmap\.org/, (route) =>
      route.fulfill({ contentType: "image/svg+xml", body: DARK_TILE })
    );
  }

  await page.goto(base);
  await page.waitForFunction(() => TrafficModel.ready);

  if (demo) {
    // Офлайн: синтетик grid сүлжээ шахаж өгнө
    await page.evaluate(() => {
      const lat0 = 47.9186, lon0 = 106.9;
      const mLat = (m) => lat0 + m / 111320;
      const mLon = (m) => lon0 + m / (111320 * Math.cos((lat0 * Math.PI) / 180));
      let wid = 1, nid = 1;
      const nodeId = new Map();
      const idOf = (p) => {
        const k = `${p.x}:${p.y}`;
        if (!nodeId.has(k)) nodeId.set(k, nid++);
        return nodeId.get(k);
      };
      const ways = [];
      const addWay = (highway, pts) => {
        ways.push({
          type: "way", id: wid++, tags: { highway },
          nodes: pts.map(idOf),
          geometry: pts.map((p) => ({ lat: mLat(p.y), lon: mLon(p.x) })),
        });
      };
      const main = [];
      for (let x = 0; x <= 4200; x += 300) main.push({ x, y: 0 });
      addWay("primary", main);
      for (let y = -900; y <= 900; y += 300) {
        if (y === 0) continue;
        const pts = [];
        for (let x = 0; x <= 4200; x += 300) pts.push({ x, y });
        addWay("residential", pts);
      }
      for (let x = 0; x <= 4200; x += 300) {
        const pts = [];
        for (let y = -900; y <= 900; y += 300) pts.push({ x, y });
        addWay("residential", pts);
      }
      const graph = buildGraph(ways);
      const start = L.latLng(mLat(-600), mLon(150));
      const end = L.latLng(mLat(600), mLon(4050));
      setPoint("start", start);
      setPoint("end", end);
      state.graph = graph;
      state.graphKey = bboxKey(computeBBox(start, end));
    });
  } else {
    // Бодит: Сүхбаатарын талбай → Дари-Эх (гэр хороолол) — Overpass-аас
    // Улаанбаатарын жинхэнэ замуудыг татаж бодно
    await page.evaluate(() => {
      setPoint("start", L.latLng(47.9186, 106.9177));
      setPoint("end", L.latLng(47.9367, 106.9635));
    });
  }

  await page.click('[data-level="jam"]');
  await page.click("#route-btn");
  await page.waitForSelector("#results:not(.hidden)", { timeout: demo ? 15000 : 180000 });
  await page.waitForTimeout(demo ? 1200 : 3000); // fitBounds + tile ачаалалт
  const file = join(outDir, `app-${demo ? "demo" : "real"}-${name}.png`);
  await page.screenshot({ path: file });
  console.log(file);
  await page.close();
}

await browser.close();
server.close();
