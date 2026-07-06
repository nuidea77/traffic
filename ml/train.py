#!/usr/bin/env python3
"""Түгжрэлийн хурдны загварын сургалт.

ml/data/ доторх бүх CSV-г уншиж (синтетик + аппаас цуглуулсан бодит өгөгдөл),
(гараг, цаг, замын ангилал) → хурдны харьцаа таамагладаг жижиг неорон сүлжээ
(MLP) сургаад жингүүдийг www/model/traffic_model.json руу экспортолно.
Апп доторх js/model.js яг ижил forward pass хийж таамаглал гаргадаг.

Онцлог вектор (8):
    sin/cos(2π·hour/24), sin/cos(2π·dow/7), weekend,
    one-hot(major, mid, minor)

Архитектур: 8 → 24 tanh → 12 tanh → 1 sigmoid, MSE, Adam.
"""
import csv
import glob
import json
import math
import os
import time

import numpy as np

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "www", "model", "traffic_model.json")
REF_PATH = os.path.join(os.path.dirname(__file__), "reference_preds.json")

CLASSES = ["major", "mid", "minor"]
HIDDEN = [24, 12]
EPOCHS = 80
BATCH = 512
LR = 3e-3
SEED = 7


def featurize(dow, hour, cls):
    return [
        math.sin(2 * math.pi * hour / 24),
        math.cos(2 * math.pi * hour / 24),
        math.sin(2 * math.pi * dow / 7),
        math.cos(2 * math.pi * dow / 7),
        1.0 if dow in (0, 6) else 0.0,
        1.0 if cls == "major" else 0.0,
        1.0 if cls == "mid" else 0.0,
        1.0 if cls == "minor" else 0.0,
    ]


def load_data():
    X, y = [], []
    files = sorted(glob.glob(os.path.join(DATA_DIR, "*.csv")))
    if not files:
        raise SystemExit("ml/data/ хоосон байна — эхлээд generate_data.py ажиллуул")
    for path in files:
        n = 0
        with open(path) as f:
            for row in csv.DictReader(f):
                cls = row["road_class"].strip()
                if cls not in CLASSES:
                    continue
                X.append(featurize(int(row["dow"]), float(row["hour"]), cls))
                y.append(float(row["speed_ratio"]))
                n += 1
        print(f"  {os.path.basename(path)}: {n} мөр")
    return np.array(X), np.array(y).reshape(-1, 1)


class MLP:
    def __init__(self, sizes, rng):
        self.W = [rng.normal(0, math.sqrt(2 / a), (a, b)) for a, b in zip(sizes, sizes[1:])]
        self.b = [np.zeros(b) for b in sizes[1:]]
        # Adam төлөв
        self.mW = [np.zeros_like(w) for w in self.W]
        self.vW = [np.zeros_like(w) for w in self.W]
        self.mb = [np.zeros_like(b) for b in self.b]
        self.vb = [np.zeros_like(b) for b in self.b]
        self.t = 0

    def forward(self, X):
        acts = [X]
        for i, (W, b) in enumerate(zip(self.W, self.b)):
            z = acts[-1] @ W + b
            acts.append(np.tanh(z) if i < len(self.W) - 1 else 1 / (1 + np.exp(-z)))
        return acts

    def train_step(self, X, y, lr):
        acts = self.forward(X)
        out = acts[-1]
        n = len(X)
        # MSE градиент; сүүлийн давхарга sigmoid, бусад нь tanh
        delta = (out - y) * out * (1 - out) * (2 / n)
        gW, gb = [None] * len(self.W), [None] * len(self.b)
        for i in reversed(range(len(self.W))):
            gW[i] = acts[i].T @ delta
            gb[i] = delta.sum(axis=0)
            if i > 0:
                delta = (delta @ self.W[i].T) * (1 - acts[i] ** 2)
        # Adam
        self.t += 1
        b1, b2, eps = 0.9, 0.999, 1e-8
        for i in range(len(self.W)):
            for g, w, m, v in ((gW[i], self.W, self.mW, self.vW), (gb[i], self.b, self.mb, self.vb)):
                m[i] = b1 * m[i] + (1 - b1) * g
                v[i] = b2 * v[i] + (1 - b2) * g**2
                mh = m[i] / (1 - b1**self.t)
                vh = v[i] / (1 - b2**self.t)
                w[i] -= lr * mh / (np.sqrt(vh) + eps)
        return float(((out - y) ** 2).mean())


def main():
    rng = np.random.default_rng(SEED)
    print("Өгөгдөл уншиж байна:")
    X, y = load_data()
    idx = rng.permutation(len(X))
    X, y = X[idx], y[idx]
    n_val = max(len(X) // 10, 1)
    Xv, yv = X[:n_val], y[:n_val]
    Xt, yt = X[n_val:], y[n_val:]
    print(f"Сургалт: {len(Xt)}, валидаци: {len(Xv)}")

    model = MLP([X.shape[1], *HIDDEN, 1], rng)
    for epoch in range(1, EPOCHS + 1):
        perm = rng.permutation(len(Xt))
        losses = [
            model.train_step(Xt[perm[i : i + BATCH]], yt[perm[i : i + BATCH]], LR)
            for i in range(0, len(Xt), BATCH)
        ]
        if epoch % 10 == 0 or epoch == 1:
            val_pred = model.forward(Xv)[-1]
            rmse = float(np.sqrt(((val_pred - yv) ** 2).mean()))
            print(f"  epoch {epoch:3d}  train MSE {np.mean(losses):.5f}  val RMSE {rmse:.4f}")

    val_rmse = float(np.sqrt(((model.forward(Xv)[-1] - yv) ** 2).mean()))
    val_mae = float(np.abs(model.forward(Xv)[-1] - yv).mean())

    # Загварыг JSON болгож экспортлох
    layers = []
    for i, (W, b) in enumerate(zip(model.W, model.b)):
        layers.append({
            "W": [[round(float(x), 6) for x in row] for row in W],
            "b": [round(float(x), 6) for x in b],
            "act": "tanh" if i < len(model.W) - 1 else "sigmoid",
        })
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump({
            "version": 1,
            "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "n_samples": len(X),
            "val_rmse": round(val_rmse, 4),
            "val_mae": round(val_mae, 4),
            "classes": CLASSES,
            "layers": layers,
        }, f)
    print(f"Загвар → {os.path.relpath(OUT_PATH)}  (val RMSE {val_rmse:.4f}, MAE {val_mae:.4f})")

    # JS inference-тэй тулгах жишиг таамаглалууд
    ref_inputs = []
    for dow in (1, 6):
        for hour in (3.0, 8.5, 13.0, 18.25, 22.0):
            for cls in CLASSES:
                ref_inputs.append({"dow": dow, "hour": hour, "cls": cls})
    Xr = np.array([featurize(r["dow"], r["hour"], r["cls"]) for r in ref_inputs])
    preds = model.forward(Xr)[-1].flatten()
    with open(REF_PATH, "w") as f:
        json.dump({"inputs": ref_inputs, "expected": [float(p) for p in preds]}, f, indent=1)

    # Хүснэгтээр эйе-тест
    print("\nТаамагласан хурдны харьцаа (Даваа гараг):")
    print("цаг      major   mid   minor")
    for hour in (3, 7, 8.5, 10, 13, 17, 18.25, 20, 22):
        row = [model.forward(np.array([featurize(1, hour, c)]))[-1][0][0] for c in CLASSES]
        print(f"{hour:5.2f}   " + "  ".join(f"{r:5.2f}" for r in row))


if __name__ == "__main__":
    main()
