#!/usr/bin/env python3
"""Улаанбаатарын түгжрэлийн хэв маягт суурилсан эхлэлийн (seed) датасет үүсгэнэ.

Бодит хэмжилтийн өгөгдөл цуглуулагдтал сургалтад ашиглах синтетик өгөгдөл.
Аппын 🚙 жолоодлогын горим яг ижил схемтэй CSV экспортолдог тул бодит
өгөгдлөө ml/data/ хавтаст хийгээд train.py-г дахин ажиллуулахад л хангалттай.

CSV схем:
    dow        - гарагийн дугаар, 0=Ням … 6=Бямба (JS Date.getDay()-тэй ижил)
    hour       - цаг, бутархай (жишээ нь 8.5 = 08:30), УБ-ын цагаар
    road_class - major | mid | minor
    speed_ratio- чөлөөт урсгалын хурдтай харьцуулсан бодит хурд (0-1]
"""
import argparse
import csv
import math
import random


def gauss(x, mu, sigma):
    return math.exp(-((x - mu) ** 2) / (2 * sigma**2))


def congestion_intensity(dow, hour):
    """Түгжрэлийн ерөнхий эрчим [0,1]. УБ: ажлын өдөр өглөө 8-9,
    орой 17:30-19:30 оргилтой, оройных нь илүү хүнд бөгөөд урт."""
    weekend = dow in (0, 6)
    if not weekend:
        c = (
            0.78 * gauss(hour, 8.6, 1.05)   # өглөөний оргил
            + 1.00 * gauss(hour, 18.1, 1.65)  # оройн оргил (хамгийн хүнд)
            + 0.32 * gauss(hour, 13.0, 2.6)   # үдийн ачаалал
        )
    else:
        c = 0.55 * gauss(hour, 14.5, 3.2)  # амралтын өдрийн үдээс хойших
    return min(c, 1.0)


# Замын ангилал бүрийн түгжрэлд өртөх мэдрэмж: гол зам хамгийн их зогсдог,
# гэр хорооллын жижиг зам харьцангуй чөлөөтэй үлддэг.
SEVERITY = {"major": 0.82, "mid": 0.65, "minor": 0.30}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-n", "--samples", type=int, default=60000)
    ap.add_argument("-o", "--out", default="ml/data/synthetic_traffic.csv")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    classes = list(SEVERITY)

    with open(args.out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["dow", "hour", "road_class", "speed_ratio"])
        for _ in range(args.samples):
            dow = rng.randrange(7)
            hour = rng.uniform(0, 24)
            cls = rng.choice(classes)
            # өдөр хоорондын санамсаргүй хэлбэлзэл + хэмжилтийн шум
            day_var = rng.gauss(1.0, 0.12)
            intensity = min(max(congestion_intensity(dow, hour) * day_var, 0), 1)
            ratio = 1.0 - intensity * SEVERITY[cls] + rng.gauss(0, 0.05)
            ratio = min(max(ratio, 0.05), 1.0)
            w.writerow([dow, round(hour, 3), cls, round(ratio, 4)])

    print(f"{args.samples} мөр → {args.out}")


if __name__ == "__main__":
    main()
