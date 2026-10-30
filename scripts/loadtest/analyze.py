#!/usr/bin/env python3
"""Per-minute breakdown of a k6 CSV run (scripts/loadtest/checkout.js).
Usage: python3 scripts/loadtest/analyze.py out/ramp.csv.gz [window_seconds]
Prints concurrent buyers, completed checkouts per second, checkout p50/p95
and the HTTP status mix for each window (see docs/CAPACITY.md)."""
import csv, gzip, sys, collections
f = sys.argv[1]
rows = csv.DictReader(gzip.open(f, "rt"))
t0 = None; W = int(sys.argv[2]) if len(sys.argv) > 2 else 60
vus = {}; status = collections.defaultdict(collections.Counter); dur = collections.defaultdict(list); ok = collections.defaultdict(lambda: [0, 0]); pay = collections.defaultdict(list)
for r in rows:
    ts = int(float(r["timestamp"])); t0 = t0 or ts; w = (ts - t0) // W
    m = r["metric_name"]
    if m == "vus": vus[w] = max(vus.get(w, 0), float(r["metric_value"]))
    elif m == "http_reqs": status[w][(r.get("step") or r.get("extra_tags","")[:20] or r["name"][:30], r["status"])] += 1
    elif m == "checkout_duration": dur[w].append(float(r["metric_value"]))
    elif m == "checkout_ok": ok[w][0] += float(r["metric_value"]); ok[w][1] += 1
    elif m == "http_req_duration" and "pay" in (r.get("extra_tags","") + r["url"]) and r["url"].endswith("/pay"): pay[w].append(float(r["metric_value"]))
def p(a, q):
    a = sorted(a); return a[int(len(a) * q)] if a else 0
for w in sorted(vus):
    d = dur[w]; okc = ok[w]
    st = collections.Counter()
    for (step, s), n in status[w].items(): st[s] += n
    print(f"t={w*W:4d}s vus={vus[w]:3.0f} checkouts_ok={okc[0]:5.0f}/{okc[1]:<5.0f} ({okc[0]/W:4.1f}/s) p50={p(d,.5)/1000:5.2f}s p95={p(d,.95)/1000:5.2f}s  pay_p95={p(pay[w],.95)/1000:5.2f}s status={dict(st)}")
