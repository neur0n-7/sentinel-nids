#!/usr/bin/env python3
"""
Sentinel database layer.
github.com/neur0n-7/sentinel-nids

SQLite setup/migration and query functions shared by the backend,
the dashboard, and the training CLI
"""

import json
import os
import sqlite3
import time
import yaml
from rich.console import Console
import sys

console = Console(highlight=False)

try:
    with open("config/config.yml") as f:
        CONFIG = yaml.safe_load(f)
except FileNotFoundError:
    console.print("[bold][red][ERROR][/red] config/config.yml was not found.[/bold]")
    print("""To create it:
Linux/macOS: cp config/config-example.yml config/config.yml
Windows: copy config/config-example.yml config/config.yml
          
Then, modify the values as needed. See README.md for a more detailed explanation on what each of these settings do.""")
    console.print("[red bold]Exiting...[/red bold]")
    sys.exit()

DB_PATH = CONFIG["database"]["path"]

FEATURE_COLUMNS = [
    "active_flows", "total_packets", "total_bytes",
    "avg_packets_per_flow", "avg_bytes_per_flow",
    "unique_destinations", "unique_ports",
]


def connect():
    return sqlite3.connect(DB_PATH)


def add_column(conn, table, column, decl):
    try:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
    except Exception:
        pass


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS monitor (
                timestamp REAL NOT NULL,
                active_flows INTEGER,
                total_packets INTEGER,
                total_bytes INTEGER,
                avg_packets_per_flow REAL,
                avg_bytes_per_flow REAL,
                unique_destinations INTEGER,
                unique_ports INTEGER,
                score REAL
            )
        """)
        add_column(conn, "monitor", "score", "REAL")
        add_column(conn, "monitor", "top_talkers", "TEXT")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS training (
                profile TEXT NOT NULL,
                timestamp REAL NOT NULL,
                active_flows INTEGER,
                total_packets INTEGER,
                total_bytes INTEGER,
                avg_packets_per_flow REAL,
                avg_bytes_per_flow REAL,
                unique_destinations INTEGER,
                unique_ports INTEGER
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS alerts (
                timestamp REAL NOT NULL,
                score REAL,
                active_flows INTEGER,
                total_packets INTEGER,
                total_bytes INTEGER,
                avg_packets_per_flow REAL,
                avg_bytes_per_flow REAL,
                unique_destinations INTEGER,
                unique_ports INTEGER
            )
        """)
        add_column(conn, "alerts", "attribution", "TEXT")
        add_column(conn, "alerts", "top_talkers", "TEXT")
        add_column(conn, "alerts", "ack", "INTEGER DEFAULT 0")
        add_column(conn, "alerts", "label", "TEXT")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS heartbeats (
                timestamp REAL NOT NULL
            )
        """)
        conn.commit()


def insert_monitor(features, top_talkers=None):
    with connect() as conn:
        cursor = conn.execute(
            """INSERT INTO monitor
               (timestamp, active_flows, total_packets, total_bytes,
                avg_packets_per_flow, avg_bytes_per_flow, unique_destinations, unique_ports,
                top_talkers)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                time.time(),
                features["active_flows"], features["total_packets"], features["total_bytes"],
                features["avg_packets_per_flow"], features["avg_bytes_per_flow"],
                features["unique_destinations"], features["unique_ports"],
                json.dumps(top_talkers) if top_talkers is not None else None,
            ),
        )
        conn.commit()
        return cursor.lastrowid


def update_monitor_score(row_id, score):
    with connect() as conn:
        conn.execute("UPDATE monitor SET score = ? WHERE rowid = ?", (score, row_id))
        conn.commit()


def get_score_stats(limit=50):
    with connect() as conn:
        row = conn.execute(
            """SELECT MIN(score), MAX(score), AVG(score)
               FROM (SELECT score FROM monitor WHERE score IS NOT NULL
                     ORDER BY timestamp DESC LIMIT ?)""",
            (limit,),
        ).fetchone()
    if row[0] is None:
        return None
    return {"min": row[0], "max": row[1], "avg": row[2]}


def get_score_distribution(limit=1000):
    with connect() as conn:
        rows = conn.execute(
            """SELECT score FROM (
                   SELECT score, timestamp FROM monitor WHERE score IS NOT NULL
                   ORDER BY timestamp DESC LIMIT ?
               )""",
            (limit,),
        ).fetchall()
    return [r[0] for r in rows]


def insert_training(features, profile):
    with connect() as conn:
        conn.execute(
            """INSERT INTO training
               (profile, timestamp, active_flows, total_packets, total_bytes,
                avg_packets_per_flow, avg_bytes_per_flow, unique_destinations, unique_ports)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                profile, time.time(),
                features["active_flows"], features["total_packets"], features["total_bytes"],
                features["avg_packets_per_flow"], features["avg_bytes_per_flow"],
                features["unique_destinations"], features["unique_ports"],
            ),
        )
        conn.commit()


def insert_alert(features, score, attribution=None, top_talkers=None):
    with connect() as conn:
        conn.execute(
            """INSERT INTO alerts
               (timestamp, score, active_flows, total_packets, total_bytes,
                avg_packets_per_flow, avg_bytes_per_flow, unique_destinations, unique_ports,
                attribution, top_talkers, ack, label)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)""",
            (
                time.time(), score,
                features["active_flows"], features["total_packets"], features["total_bytes"],
                features["avg_packets_per_flow"], features["avg_bytes_per_flow"],
                features["unique_destinations"], features["unique_ports"],
                json.dumps(attribution) if attribution is not None else None,
                json.dumps(top_talkers) if top_talkers is not None else None,
            ),
        )
        conn.commit()


def get_profile_features(profile):
    with connect() as conn:
        cursor = conn.execute(
            f"SELECT {', '.join(FEATURE_COLUMNS)} FROM training WHERE profile = ?",
            (profile,),
        )
        return cursor.fetchall()


def profile_row_count(profile):
    with connect() as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM training WHERE profile = ?", (profile,)
        ).fetchone()[0]


def get_monitor_count():
    with connect() as conn:
        return conn.execute("SELECT COUNT(*) FROM monitor").fetchone()[0]


def get_training_profiles():
    with connect() as conn:
        cursor = conn.execute(
            "SELECT profile, COUNT(*) as count FROM training GROUP BY profile ORDER BY profile"
        )
        return [{"profile": r[0], "count": r[1]} for r in cursor.fetchall()]


def row_to_alert_dict(cols, row):
    d = dict(zip(cols, row))
    if d.get("attribution"):
        try:
            d["attribution"] = json.loads(d["attribution"])
        except Exception:
            d["attribution"] = None
    if d.get("top_talkers"):
        try:
            d["top_talkers"] = json.loads(d["top_talkers"])
        except Exception:
            d["top_talkers"] = None
    return d


def get_recent_alerts(limit=50, start=None, end=None, label=None, ack=None):
    query = """SELECT rowid AS id, timestamp, score, active_flows, total_packets, total_bytes,
                      avg_packets_per_flow, avg_bytes_per_flow, unique_destinations, unique_ports,
                      attribution, top_talkers, ack, label
               FROM alerts WHERE 1=1"""
    params = []
    if start is not None:
        query += " AND timestamp >= ?"
        params.append(start)
    if end is not None:
        query += " AND timestamp <= ?"
        params.append(end)
    if label is not None:
        query += " AND label = ?"
        params.append(label)
    if ack is not None:
        query += " AND ack = ?"
        params.append(1 if ack else 0)
    query += " ORDER BY timestamp DESC LIMIT ?"
    params.append(limit)
    with connect() as conn:
        cursor = conn.execute(query, params)
        cols = [d[0] for d in cursor.description]
        return [row_to_alert_dict(cols, row) for row in cursor.fetchall()]


def update_alert_ack(alert_id, ack):
    with connect() as conn:
        conn.execute("UPDATE alerts SET ack = ? WHERE rowid = ?", (1 if ack else 0, alert_id))
        conn.commit()


def update_alert_label(alert_id, label):
    with connect() as conn:
        conn.execute("UPDATE alerts SET label = ? WHERE rowid = ?", (label, alert_id))
        conn.commit()


def get_status():
    with connect() as conn:
        total_alerts = conn.execute("SELECT COUNT(*) FROM alerts").fetchone()[0]
        monitor_count = conn.execute("SELECT COUNT(*) FROM monitor").fetchone()[0]
        row = conn.execute(
            "SELECT timestamp FROM monitor ORDER BY timestamp DESC LIMIT 1"
        ).fetchone()
    return {
        "total_alerts": total_alerts,
        "monitor_count": monitor_count,
        "last_seen": row[0] if row else None,
    }


def get_monitor_page(limit=50, offset=0, start=None, end=None):
    query = """SELECT rowid AS id, timestamp, active_flows, total_packets, total_bytes,
                      avg_packets_per_flow, avg_bytes_per_flow, unique_destinations, unique_ports,
                      score, top_talkers
               FROM monitor WHERE 1=1"""
    params = []
    if start is not None:
        query += " AND timestamp >= ?"
        params.append(start)
    if end is not None:
        query += " AND timestamp <= ?"
        params.append(end)
    query += " ORDER BY timestamp DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])

    count_query = "SELECT COUNT(*) FROM monitor WHERE 1=1"
    count_params = []
    if start is not None:
        count_query += " AND timestamp >= ?"
        count_params.append(start)
    if end is not None:
        count_query += " AND timestamp <= ?"
        count_params.append(end)

    with connect() as conn:
        cursor = conn.execute(query, params)
        cols = [d[0] for d in cursor.description]
        rows = []
        for row in cursor.fetchall():
            d = dict(zip(cols, row))
            if d.get("top_talkers"):
                try:
                    d["top_talkers"] = json.loads(d["top_talkers"])
                except Exception:
                    d["top_talkers"] = None
            rows.append(d)
        total = conn.execute(count_query, count_params).fetchone()[0]
    return rows, total


def get_top_talkers_aggregate(limit=20):
    """Merge top_talkers breakdowns from the most recent monitor windows."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT top_talkers FROM monitor WHERE top_talkers IS NOT NULL ORDER BY timestamp DESC LIMIT ?",
            (limit,),
        ).fetchall()

    src_bytes, dst_bytes, port_counts = {}, {}, {}
    for (raw,) in rows:
        try:
            tt = json.loads(raw)
        except Exception:
            continue
        for ip, b in (tt.get("top_sources") or []):
            src_bytes[ip] = src_bytes.get(ip, 0) + b
        for ip, b in (tt.get("top_destinations") or []):
            dst_bytes[ip] = dst_bytes.get(ip, 0) + b
        for port, c in (tt.get("top_ports") or []):
            port_counts[port] = port_counts.get(port, 0) + c

    top_sources = sorted(src_bytes.items(), key=lambda x: -x[1])[:10]
    top_destinations = sorted(dst_bytes.items(), key=lambda x: -x[1])[:10]
    top_ports = sorted(port_counts.items(), key=lambda x: -x[1])[:10]
    return {
        "top_sources": [{"ip": k, "bytes": v} for k, v in top_sources],
        "top_destinations": [{"ip": k, "bytes": v} for k, v in top_destinations],
        "top_ports": [{"port": k, "count": v} for k, v in top_ports],
    }


def insert_heartbeat(timestamp):
    with connect() as conn:
        conn.execute("INSERT INTO heartbeats (timestamp) VALUES (?)", (timestamp,))
        conn.commit()


def get_heartbeat_history(since):
    with connect() as conn:
        rows = conn.execute(
            "SELECT timestamp FROM heartbeats WHERE timestamp >= ? ORDER BY timestamp",
            (since,),
        ).fetchall()
    return [r[0] for r in rows]


def prune_heartbeats(before):
    with connect() as conn:
        conn.execute("DELETE FROM heartbeats WHERE timestamp < ?", (before,))
        conn.commit()


def get_training_profile_stats():
    with connect() as conn:
        cursor = conn.execute(
            """SELECT profile, COUNT(*) as count,
                      MIN(timestamp) as first_seen, MAX(timestamp) as last_seen
               FROM training GROUP BY profile ORDER BY profile"""
        )
        return [
            {"profile": r[0], "count": r[1], "first_seen": r[2], "last_seen": r[3]}
            for r in cursor.fetchall()
        ]
