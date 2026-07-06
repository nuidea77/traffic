/**
 * model.js — Түгжрэлийн AI загварын in-app inference + бодит өгөгдөл цуглуулалт.
 *
 * ml/train.py-ийн сургаж экспортолсон неорон сүлжээг (model/traffic_model.json)
 * ачаалж, (гараг, цаг, замын ангилал) → хурдны харьцаа таамаглана. Forward
 * pass нь Python талтай яг ижил онцлог вектор ашигладаг.
 *
 * Мөн 🚙 жолоодлогын горимд GPS-ээс бодит хурдны хэмжилт цуглуулж:
 *   1. Локал calibration — таны явдаг замын бодит байдалд таамаглалыг
 *      аажмаар тааруулна (exponential moving average холимог).
 *   2. CSV экспорт — ml/data/-д хийгээд train.py-г дахин ажиллуулбал
 *      загвар бодит өгөгдлөөр сайжирна.
 */

const TrafficModel = {
  layers: null,
  meta: null,

  async load(url = "model/traffic_model.json") {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Загвар ачаалагдсангүй (HTTP ${res.status})`);
    const data = await res.json();
    this.layers = data.layers;
    this.meta = data;
    return data;
  },

  get ready() {
    return !!this.layers;
  },

  /** ml/train.py-ийн featurize()-тэй яг ижил байх ёстой. */
  featurize(dow, hour, cls) {
    return [
      Math.sin((2 * Math.PI * hour) / 24),
      Math.cos((2 * Math.PI * hour) / 24),
      Math.sin((2 * Math.PI * dow) / 7),
      Math.cos((2 * Math.PI * dow) / 7),
      dow === 0 || dow === 6 ? 1 : 0,
      cls === "major" ? 1 : 0,
      cls === "mid" ? 1 : 0,
      cls === "minor" ? 1 : 0,
    ];
  },

  forward(x) {
    let v = x;
    for (const layer of this.layers) {
      const out = new Array(layer.b.length);
      for (let j = 0; j < layer.b.length; j++) {
        let z = layer.b[j];
        for (let i = 0; i < v.length; i++) z += v[i] * layer.W[i][j];
        out[j] = layer.act === "sigmoid" ? 1 / (1 + Math.exp(-z)) : Math.tanh(z);
      }
      v = out;
    }
    return v[0];
  },

  /** Нэг ангиллын хурдны харьцаа (calibration-тай хамт). */
  predict(cls, dow, hour) {
    const raw = this.forward(this.featurize(dow, hour, cls));
    return Calibration.blend(cls, dow, hour, raw);
  },

  /** Гурван ангиллын коэффициент — router-ийн жинд шууд өгнө. */
  predictFactors(dow, hour) {
    const f = {};
    for (const cls of ["major", "mid", "minor"]) f[cls] = this.predict(cls, dow, hour);
    // Түгжрэл ихсэх тусам уулзвар гарахад удаан гэж загварын гол замын
    // таамаглалаас уулзварын саатлыг гаргана.
    f.junctionPenalty = 3 + 5 * (1 - f.major);
    return f;
  },
};

/**
 * Calibration — таны бодит хэмжилтээр загварын таамаглалыг залруулна.
 * (ангилал × амралтын өдөр эсэх × 3 цагийн бүлэг) түлхүүр бүрд EMA хөтөлж,
 * хэмжилт олширох тусам EMA-д илүү жин өгнө (дээд тал нь 50%).
 */
const Calibration = {
  KEY: "traffic-calibration-v1",
  SAMPLES_KEY: "traffic-samples-v1",
  MAX_SAMPLES: 20000,
  _cells: null,

  _load() {
    if (!this._cells) {
      try {
        this._cells = JSON.parse(localStorage.getItem(this.KEY)) || {};
      } catch {
        this._cells = {};
      }
    }
    return this._cells;
  },

  _cellKey(cls, dow, hour) {
    const weekend = dow === 0 || dow === 6 ? "w" : "d";
    return `${cls}:${weekend}:${Math.floor(hour / 3)}`;
  },

  /** Бодит хэмжилт нэмнэ (ratio = бодит хурд / чөлөөт урсгалын хурд). */
  addSample(cls, dow, hour, ratio) {
    const cells = this._load();
    const key = this._cellKey(cls, dow, hour);
    const cell = cells[key] || { ema: ratio, n: 0 };
    cell.ema = cell.ema * 0.9 + ratio * 0.1;
    cell.n += 1;
    cells[key] = cell;
    localStorage.setItem(this.KEY, JSON.stringify(cells));

    let samples = [];
    try {
      samples = JSON.parse(localStorage.getItem(this.SAMPLES_KEY)) || [];
    } catch { /* эвдэрсэн бол шинээр эхэлнэ */ }
    samples.push([dow, +hour.toFixed(3), cls, +ratio.toFixed(4)]);
    if (samples.length > this.MAX_SAMPLES) samples = samples.slice(-this.MAX_SAMPLES);
    localStorage.setItem(this.SAMPLES_KEY, JSON.stringify(samples));
  },

  sampleCount() {
    try {
      return (JSON.parse(localStorage.getItem(this.SAMPLES_KEY)) || []).length;
    } catch {
      return 0;
    }
  },

  /** Загварын таамаглалыг локал хэмжилттэй холино. */
  blend(cls, dow, hour, modelPred) {
    const cell = this._load()[this._cellKey(cls, dow, hour)];
    if (!cell || cell.n < 3) return modelPred;
    const w = Math.min(cell.n / 20, 1) * 0.5;
    return modelPred * (1 - w) + cell.ema * w;
  },

  /** Цуглуулсан хэмжилтүүдийг ml/data/-гийн CSV схемээр экспортолно. */
  exportCsv() {
    let samples = [];
    try {
      samples = JSON.parse(localStorage.getItem(this.SAMPLES_KEY)) || [];
    } catch { /* хоосон */ }
    const lines = ["dow,hour,road_class,speed_ratio"];
    for (const [dow, hour, cls, ratio] of samples) {
      lines.push(`${dow},${hour},${cls},${ratio}`);
    }
    return lines.join("\n");
  },
};
