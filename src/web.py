#!/usr/bin/env python3
"""
Sentinel dashboard.
github.com/neur0n-7/sentinel-nids

Flask app serving the web dashboard and its JSON API.

Usage:
  python src/web.py
"""

import csv
import io
import os
import pickle
import re
import time

import pandas as pd
import yaml
from flask import Flask, Response, jsonify, render_template, request
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler

import database

CONFIG_PATH = "config/config.yml"

with open(CONFIG_PATH) as f:
    CONFIG = yaml.safe_load(f)

app = Flask(__name__)

heartbeat = {"last_seen": None, "started_at": None}
HEARTBEAT_TIMEOUT = 90  # seconds - backend considered down after this


def parse_time_range():
    start = request.args.get("start", type=float)
    end = request.args.get("end", type=float)
    return start, end


def capture_is_stale():
    """True if the backend hasn't produced a new monitor window recently (paused capture)."""
    status = database.get_status()
    last_seen = status.get("last_seen")
    if last_seen is None:
        return True
    window = CONFIG["aggregation"]["window"]
    return (time.time() - last_seen) > (window * 3)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    status = database.get_status()
    model_path = CONFIG.get("model", {}).get("path", "models/nids.pkl")
    status["model_loaded"] = os.path.exists(model_path)
    status["capture_stale"] = capture_is_stale()
    return jsonify(status)


@app.route("/api/system")
def api_system():
    model_path = CONFIG.get("model", {}).get("path", "models/nids.pkl")
    return jsonify({
        "model_path": model_path,
        "model_loaded": os.path.exists(model_path),
        "window": CONFIG["aggregation"]["window"],
        "contamination": CONFIG["model"]["contamination"],
        "db_path": CONFIG["database"]["path"],
        "monitor_count": database.get_monitor_count(),
        "training_profiles": database.get_training_profile_stats(),
        "score_stats": database.get_score_stats(50),
        "alert_threshold": CONFIG.get("model", {}).get("alert_threshold", -0.10),
    })


@app.route("/api/alerts")
def api_alerts():
    limit = request.args.get("limit", 50, type=int)
    start, end = parse_time_range()
    label = request.args.get("label") or None
    ack_param = request.args.get("ack")
    ack = None
    if ack_param is not None:
        ack = ack_param.lower() in ("1", "true", "yes")
    return jsonify(database.get_recent_alerts(limit, start=start, end=end, label=label, ack=ack))


@app.route("/api/alerts/<int:alert_id>/ack", methods=["POST"])
def api_alert_ack(alert_id):
    body = request.json or {}
    ack = bool(body.get("ack", True))
    database.update_alert_ack(alert_id, ack)
    return jsonify({"ok": True, "id": alert_id, "ack": ack})


@app.route("/api/alerts/<int:alert_id>/label", methods=["POST"])
def api_alert_label(alert_id):
    body = request.json or {}
    label = body.get("label")
    if label not in (None, "tp", "fp"):
        return jsonify({"error": "label must be 'tp', 'fp', or null"}), 400
    database.update_alert_label(alert_id, label)
    return jsonify({"ok": True, "id": alert_id, "label": label})


@app.route("/api/alerts/export")
def api_alerts_export():
    start, end = parse_time_range()
    label = request.args.get("label") or None
    alerts = database.get_recent_alerts(100000, start=start, end=end, label=label)

    buf = io.StringIO()
    fieldnames = ["id", "timestamp", "score", "active_flows", "total_packets", "total_bytes",
                  "avg_packets_per_flow", "avg_bytes_per_flow", "unique_destinations", "unique_ports",
                  "ack", "label"]
    writer = csv.DictWriter(buf, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()
    for a in alerts:
        writer.writerow(a)

    return Response(
        buf.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=alerts.csv"},
    )


@app.route("/api/monitor/export")
def api_monitor_export():
    start, end = parse_time_range()
    rows, _ = database.get_monitor_page(100000, 0, start=start, end=end)

    buf = io.StringIO()
    fieldnames = ["id", "timestamp", "active_flows", "total_packets", "total_bytes",
                  "avg_packets_per_flow", "avg_bytes_per_flow", "unique_destinations",
                  "unique_ports", "score"]
    writer = csv.DictWriter(buf, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()
    for r in rows:
        writer.writerow(r)

    return Response(
        buf.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=monitor.csv"},
    )


@app.route("/api/scores/histogram")
def api_scores_histogram():
    limit = request.args.get("limit", 1000, type=int)
    bins = request.args.get("bins", 20, type=int)
    scores = database.get_score_distribution(limit)
    if not scores:
        return jsonify({"buckets": [], "min": None, "max": None})

    lo, hi = min(scores), max(scores)
    if lo == hi:
        lo -= 0.5
        hi += 0.5
    width = (hi - lo) / bins
    counts = [0] * bins
    for s in scores:
        idx = int((s - lo) / width) if width else 0
        idx = min(idx, bins - 1)
        counts[idx] += 1

    buckets = [{"start": lo + i * width, "end": lo + (i + 1) * width, "count": counts[i]} for i in range(bins)]
    return jsonify({"buckets": buckets, "min": lo, "max": hi})


@app.route("/api/logs")
def api_logs():
    log_file = os.path.join("logs", CONFIG["logging"]["file"])
    if not os.path.exists(log_file):
        return jsonify({"lines": []})
    with open(log_file, encoding="utf-8") as f:
        lines = f.readlines()
    tail = [l.rstrip() for l in lines[-200:]]
    return jsonify({"lines": tail})


@app.route("/api/heartbeat", methods=["POST"])
def api_heartbeat():
    data = request.json or {}
    heartbeat["last_seen"] = time.time()
    if data.get("started_at"):
        heartbeat["started_at"] = data["started_at"]
    return jsonify({"ok": True})


@app.route("/api/backend-status")
def api_backend_status():
    now = time.time()
    last_seen = heartbeat["last_seen"]
    started_at = heartbeat["started_at"]
    running = last_seen is not None and (now - last_seen) < HEARTBEAT_TIMEOUT
    return jsonify({
        "running": running,
        "started_at": started_at,
        "last_seen": last_seen,
        "uptime": now - started_at if running and started_at else None,
        "capture_stale": capture_is_stale() if running else False,
    })


@app.route("/api/health-history")
def api_health_history():
    hours = request.args.get("hours", 24, type=float)
    buckets = request.args.get("buckets", 96, type=int)
    now = time.time()
    since = now - hours * 3600
    heartbeats = database.get_heartbeat_history(since)

    bucket_seconds = (hours * 3600) / buckets
    slots = [False] * buckets
    for ts in heartbeats:
        idx = int((ts - since) / bucket_seconds)
        if 0 <= idx < buckets:
            slots[idx] = True

    return jsonify({
        "since": since,
        "until": now,
        "bucket_seconds": bucket_seconds,
        "slots": slots,
    })


@app.route("/api/monitor")
def api_monitor():
    limit = request.args.get("limit", 50, type=int)
    offset = request.args.get("offset", 0, type=int)
    start, end = parse_time_range()
    rows, total = database.get_monitor_page(limit, offset, start=start, end=end)
    return jsonify({"rows": rows, "total": total, "limit": limit, "offset": offset})


@app.route("/api/top-talkers")
def api_top_talkers():
    limit = request.args.get("limit", 20, type=int)
    return jsonify(database.get_top_talkers_aggregate(limit))


@app.route("/api/config/threshold", methods=["POST"])
def api_config_threshold():
    body = request.json or {}
    try:
        new_value = float(body.get("threshold"))
    except (TypeError, ValueError):
        return jsonify({"error": "threshold must be a number"}), 400

    with open(CONFIG_PATH, encoding="utf-8") as f:
        lines = f.readlines()

    pattern = re.compile(r"^(\s*alert_threshold:\s*)(-?[0-9.]+)(.*)$")
    updated = False
    for i, line in enumerate(lines):
        m = pattern.match(line)
        if m:
            lines[i] = f"{m.group(1)}{new_value}{m.group(3)}\n"
            updated = True
            break

    if not updated:
        return jsonify({"error": "alert_threshold key not found in config"}), 500

    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        f.writelines(lines)

    CONFIG.setdefault("model", {})["alert_threshold"] = new_value
    return jsonify({"ok": True, "alert_threshold": new_value})


def _replace_nested_value(section, key, new_value):
    """Rewrite `key: value` under a top-level `section:` block in config.yml, leaving everything else untouched."""
    with open(CONFIG_PATH, encoding="utf-8") as f:
        lines = f.readlines()

    in_section = False
    key_pattern = re.compile(rf"^(\s*{re.escape(key)}:\s*)(\S+)(.*)$")
    updated = False
    for i, line in enumerate(lines):
        if re.match(rf"^{re.escape(section)}:\s*$", line):
            in_section = True
            continue
        if in_section:
            if line.strip() and not line[0].isspace():
                break  # left the section without finding the key
            m = key_pattern.match(line)
            if m:
                lines[i] = f"{m.group(1)}{new_value}{m.group(3)}\n"
                updated = True
                break

    if updated:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            f.writelines(lines)
    return updated


@app.route("/api/models")
def api_models():
    models_dir = "models"
    active = CONFIG.get("model", {}).get("path", "models/nids.pkl").replace("\\", "/")
    models = []
    if os.path.isdir(models_dir):
        for fname in sorted(os.listdir(models_dir)):
            if not fname.endswith(".pkl"):
                continue
            path = f"{models_dir}/{fname}"
            stat = os.stat(path)
            models.append({
                "path": path,
                "name": fname,
                "size": stat.st_size,
                "modified": stat.st_mtime,
                "active": path == active,
            })
    return jsonify({"models": models, "active": active})


@app.route("/api/config/model", methods=["POST"])
def api_config_model():
    body = request.json or {}
    new_path = (body.get("path") or "").replace("\\", "/")
    if not new_path:
        return jsonify({"error": "path required"}), 400
    if not os.path.exists(new_path):
        return jsonify({"error": f"Model file not found: {new_path}"}), 400

    if not _replace_nested_value("model", "path", new_path):
        return jsonify({"error": "model.path key not found in config"}), 500

    CONFIG.setdefault("model", {})["path"] = new_path
    return jsonify({"ok": True, "path": new_path})


@app.route("/api/train", methods=["POST"])
def api_train():

    body = request.json or {}
    profile = body.get("profile")
    filename = body.get("file") or profile
    if not profile:
        return jsonify({"error": "profile required"}), 400
    if not filename or not re.fullmatch(r"[\w-]+", filename):
        return jsonify({"error": "file must contain only letters, numbers, underscores, and hyphens"}), 400

    rows = database.get_profile_features(profile)
    if not rows:
        return jsonify({"error": f"No training data for profile '{profile}'"}), 400

    df = pd.DataFrame(rows, columns=database.FEATURE_COLUMNS)
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(df)
    contamination = CONFIG["model"]["contamination"]
    model = IsolationForest(contamination=contamination, random_state=42)
    model.fit(X_scaled)

    os.makedirs("models", exist_ok=True)
    model_path = f"models/{filename}.pkl"
    with open(model_path, "wb") as f:
        pickle.dump({"model": model, "scaler": scaler}, f)

    return jsonify({"ok": True, "rows": len(rows), "path": model_path})


if __name__ == "__main__":
    database.init_db()
    app.run(host=CONFIG["dashboard"]["host"], debug=True, port=CONFIG["dashboard"]["port"])
