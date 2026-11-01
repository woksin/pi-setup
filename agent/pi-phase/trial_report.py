"""Read-only trial windows and shadow accuracy over optional ledger fields."""
from collections import Counter
from datetime import datetime
import math


def numeric(value):
    return type(value) in (int, float) and math.isfinite(value)


def percentile(values, percent):
    return sorted(values)[math.ceil(len(values) * percent / 100) - 1] if values else None


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(value)
        return parsed.timestamp() if parsed.tzinfo is not None else None
    except (ValueError, TypeError, OverflowError):
        return None


def confusion(counter, predicted, positive):
    key = ("tp" if positive else "fp") if predicted else ("fn" if positive else "tn")
    counter[key] += 1


def shadow_summary(records):
    result = dict(n=0, mdapePct={}, would=dict(tp=0, fp=0, fn=0, tn=0), current=dict(tp=0, fp=0, fn=0, tn=0))
    errors = dict(warm=[], cold=[], any=[])
    for record in records:
        shadow = record.get("fastShadow")
        run = record.get("runS")
        if (record.get("outcome") != "passed" or not isinstance(shadow, dict) or not numeric(run)
                or not numeric(shadow.get("limS"))):
            continue
        result["n"] += 1
        positive = run <= shadow["limS"]
        confusion(result["would"], shadow.get("would") is True, positive)
        confusion(result["current"], record.get("fast") is True, positive)
        basis = str(shadow.get("basis", "")).rsplit("-", 1)[-1]
        if basis in errors and run > 0 and numeric(shadow.get("predS")):
            errors[basis].append(abs(shadow["predS"] - run) / run * 100)
    result["mdapePct"] = {key: percentile(values, 50) for key, values in errors.items()}
    return result


def union(intervals):
    merged = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return merged


def backlog(records):
    intervals = []
    for record in records:
        queued, started = timestamp(record.get("queuedAt")), timestamp(record.get("startedAt"))
        if (record.get("policy") == "queued" and numeric(record.get("waitS")) and record["waitS"] > 5
                and queued is not None and started is not None and started >= queued):
            intervals.append((queued, started))
    return union(intervals)


def values(records, key):
    return [r[key] for r in records if numeric(r.get(key))]


def latency(records):
    samples = [r["waitS"] + r["runS"] for r in records if numeric(r.get("waitS")) and numeric(r.get("runS"))]
    return dict(p50=percentile(samples, 50), p95=percentile(samples, 95))


def metrics(records, eligible, span, timeout_stamps):
    intervals = backlog(records)
    backlog_h = sum(end - start for start, end in intervals) / 3600
    completed = [r for r in records if r.get("startedAt") is not None and r.get("outcome") in ("passed", "failed")]
    in_backlog = 0
    for record in completed:
        ended = timestamp(record.get("endedAt"))
        in_backlog += ended is not None and any(start <= ended <= end for start, end in intervals)
    timeouts = [r for r in records if r.get("outcome") == "timeout"]
    retry = [r for r in records if r.get("retryOf") in timeout_stamps]
    hosts = [r["host"] for r in records if isinstance(r.get("host"), dict)]
    swaps = values(hosts, "swapMb")
    kinds = ("build", "test", "integration")
    hangs = Counter(r["hangTimeout"] for r in records if isinstance(r.get("hangTimeout"), str))
    hangs["hangKill"] = sum(r.get("hangKill") is True for r in records)
    return dict(spanH=span, records=len(records), started=sum(r.get("startedAt") is not None for r in records),
                completed=len(completed), backlogH=backlog_h,
                completedPerH=len(completed) / span if span > 0 else None,
                completedPerBacklogH=in_backlog / backlog_h if backlog_h >= 0.1 else None,
                waitRunS=dict(all=latency(eligible), **{kind: latency([r for r in eligible if r.get("kind") == kind]) for kind in kinds}),
                runS={kind: dict(p95=percentile(values([r for r in eligible if r.get("kind") == kind], "runS"), 95)) for kind in kinds},
                timeouts=len(timeouts), timeoutH=sum(values(timeouts, "runS")) / 3600,
                queueTimeouts=sum(r.get("outcome") == "queue-timeout" for r in records),
                retryAfterTimeoutH=sum(values(retry, "runS")) / 3600,
                swapGrowth=percentile(values(hosts, "swapGrowth"), 95), swapMbMax=max(swaps) if swaps else None,
                load1=percentile(values(hosts, "load1"), 50), peakRssMb=percentile(values(records, "peakRssMb"), 95),
                childCpuH=sum(values(records, "childCpuS")) / 3600,
                mix=dict(kind=dict(Counter(r.get("kind", "unknown") for r in records)),
                         policy=dict(Counter(r.get("policy", "unknown") for r in records)),
                         repoKey=dict(Counter(r.get("repoKey", "unknown") for r in records).most_common(8))), hang=dict(hangs))


def window_samples(records, start, end, settle):
    eligible, counts = [], dict(carryOver=0, settling=0, spill=0)
    for record in records:
        queued, started = timestamp(record.get("queuedAt")), timestamp(record.get("startedAt"))
        settling = queued is not None and queued < start + settle
        spill = started is not None and started >= end
        counts["carryOver"] += queued is not None and queued < start
        counts["settling"] += settling
        counts["spill"] += spill
        if not settling and not spill:
            eligible.append(record)
    return eligible, counts


def trial_summary(records, name, settle=900):
    groups = {}
    for record in records:
        marker = record.get("trial")
        if (isinstance(marker, dict) and marker.get("name") == name and isinstance(marker.get("arm"), str)
                and isinstance(marker.get("started"), str) and timestamp(marker["started"]) is not None):
            groups.setdefault((marker["arm"], marker["started"]), []).append(record)
    keys = sorted(groups, key=lambda key: (timestamp(key[1]), key[0]))
    starts = sorted(set(timestamp(key[1]) for key in keys))
    timeout_stamps = {r.get("ts") for r in records if r.get("outcome") == "timeout" and isinstance(r.get("ts"), str)}
    windows, arms = [], {}
    for arm, started in keys:
        samples = groups[(arm, started)]
        start = timestamp(started)
        later = [value for value in starts if value > start]
        ends = [value for r in samples if (value := timestamp(r.get("endedAt"))) is not None]
        end = later[0] if later else max(ends, default=start)
        span = max(0, end - start) / 3600
        eligible, counts = window_samples(samples, start, end, settle)
        summary = metrics(samples, eligible, span, timeout_stamps)
        windows.append(dict(arm=arm, windowStarted=started, **summary, **counts))
        pool = arms.setdefault(arm, dict(records=[], eligible=[], span=0, windows=0, validWindows=0,
                                        carryOver=0, settling=0, spill=0))
        pool["records"].extend(samples)
        pool["eligible"].extend(eligible)
        pool["span"] += span
        pool["windows"] += 1
        pool["validWindows"] += summary["backlogH"] >= 0.5 and summary["completed"] >= 20
        for key, value in counts.items():
            pool[key] += value
    pooled = {}
    for arm, pool in arms.items():
        summary = metrics(pool["records"], pool["eligible"], pool["span"], timeout_stamps)
        pooled[arm] = dict(summary, **{key: pool[key] for key in ("windows", "validWindows", "carryOver", "settling", "spill")})
    return dict(trial=name, windows=windows, arms=pooled)


def trial_text(result):
    lines = [f"pi-phase: trial {result['trial']}"]
    items = [(f"window {r['arm']} {r['windowStarted']}", r) for r in result["windows"]]
    items.extend((f"arm {arm}", r) for arm, r in result["arms"].items())
    for label, summary in items:
        fields = ("records", "completed", "spanH", "backlogH", "completedPerH", "completedPerBacklogH", "timeouts", "childCpuH")
        lines.append(label + " " + " ".join(f"{key}={summary[key]}" for key in fields))
    return "\n".join(lines)
