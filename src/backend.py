#!/usr/bin/env python3
"""
Sentinel capture backend.
github.com/neur0n-7/sentinel-nids

Sniffs live traffic, aggregates it into time windows, scores each
window, and writes windows and alerts to the SQLite database.
"""
import json
import os
import pickle
import threading
import time
import urllib.request
import yaml
import pandas as pd
from rich.console import Console
from rich.text import Text
from scapy.all import sniff
from scapy.layers.inet import IP, TCP, UDP
import sys
import database

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

FEATURE_COLUMNS = [
    "active_flows", "total_packets", "total_bytes",
    "avg_packets_per_flow", "avg_bytes_per_flow",
    "unique_destinations", "unique_ports",
]

LOG_FILE = CONFIG["logging"]["file"]
HEARTBEAT_URL = f"http://{CONFIG['dashboard']['host']}:{CONFIG['dashboard']['port']}/api/heartbeat"
HEARTBEAT_INTERVAL = CONFIG["dashboard"].get("heartbeat_interval", 30)


LEVEL_STYLES = {
    "INFO":    "dim white",
    "STARTUP": "bold green",
    "WARN":    "bold yellow",
    "ALERT":   "bold red",
}

def log(message, level="INFO"):
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] [{level}] {message}"
    style = LEVEL_STYLES.get(level, "white")
    console.print(Text(line, style=style))
    os.makedirs("logs", exist_ok=True)
    with open(f"logs/{LOG_FILE}", "a", encoding="utf-8") as f:
        f.write(line + "\n")


HEARTBEAT_RETENTION = 48 * 3600  # seconds - drop heartbeats older than this


def send_heartbeat(started_at):
    now = time.time()
    database.insert_heartbeat(now)
    database.prune_heartbeats(now - HEARTBEAT_RETENTION)
    try:
        data = json.dumps({"started_at": started_at}).encode()
        req = urllib.request.Request(
            HEARTBEAT_URL, data=data,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        urllib.request.urlopen(req, timeout=2)
    except Exception:
        pass


def start_heartbeat(started_at, on_tick=None):
    def loop():
        while True:
            send_heartbeat(started_at)
            if on_tick:
                on_tick()
            time.sleep(HEARTBEAT_INTERVAL)
    threading.Thread(target=loop, daemon=True).start()


def extract_features(connections):
    if not connections:
        return {k: 0 for k in FEATURE_COLUMNS}
    total_packets = sum(c["packet_count"] for c in connections.values())
    total_bytes = sum(c["byte_count"] for c in connections.values())
    n = len(connections)
    return {
        "active_flows": n,
        "total_packets": total_packets,
        "total_bytes": total_bytes,
        "avg_packets_per_flow": total_packets / n,
        "avg_bytes_per_flow": total_bytes / n,
        "unique_destinations": len(set(k[1] for k in connections.keys())),
        "unique_ports": len(set(k[3] for k in connections.keys())),
    }


def extract_top_talkers(connections, top_n=5):
    """Breakdown of a window's traffic by source IP, destination IP, and port (by bytes/count)."""
    src_bytes, dst_bytes, port_counts = {}, {}, {}
    for (src_ip, dst_ip, src_port, dst_port, proto), c in connections.items():
        src_bytes[src_ip] = src_bytes.get(src_ip, 0) + c["byte_count"]
        dst_bytes[dst_ip] = dst_bytes.get(dst_ip, 0) + c["byte_count"]
        port_counts[dst_port] = port_counts.get(dst_port, 0) + 1

    top_sources = sorted(src_bytes.items(), key=lambda x: -x[1])[:top_n]
    top_destinations = sorted(dst_bytes.items(), key=lambda x: -x[1])[:top_n]
    top_ports = sorted(port_counts.items(), key=lambda x: -x[1])[:top_n]
    return {
        "top_sources": top_sources,
        "top_destinations": top_destinations,
        "top_ports": top_ports,
    }


def capture_traffic(on_window, window_seconds, minutes=None):
    connections = {}
    last_window_time = [time.time()]

    def process_packet(packet):
        if IP not in packet:
            return
        src_ip = packet[IP].src
        dst_ip = packet[IP].dst
        if TCP in packet:
            src_port, dst_port = packet[TCP].sport, packet[TCP].dport
            proto = "TCP"
        elif UDP in packet:
            src_port, dst_port = packet[UDP].sport, packet[UDP].dport
            proto = "UDP"
        else:
            return

        key = (src_ip, dst_ip, src_port, dst_port, proto)
        if key not in connections:
            connections[key] = {
                "packet_count": 0,
                "byte_count": 0,
                "first_seen": time.time(),
                "last_seen": time.time(),
            }
        connections[key]["packet_count"] += 1
        connections[key]["byte_count"] += len(packet)
        connections[key]["last_seen"] = time.time()

        now = time.time()
        if now - last_window_time[0] >= window_seconds:
            features = extract_features(connections)
            breakdown = extract_top_talkers(connections)
            on_window(features, breakdown)
            connections.clear()
            last_window_time[0] = now

    timeout = minutes * 60 if minutes else None
    sniff(prn=process_packet, store=False, timeout=timeout)


class Backend:
    def __init__(self, model_path=None):
        database.init_db()
        self.window = CONFIG["aggregation"]["window"]
        self._started_at = time.time()
        self.model_path = model_path or CONFIG.get("model", {}).get("path", "models/nids.pkl")
        self._alert_threshold = CONFIG.get("model", {}).get("alert_threshold", -0.10)
        self.model_data = None
        self._load_model(self.model_path)
        start_heartbeat(self._started_at, on_tick=self.reload_if_changed)

    def _load_model(self, model_path):
        if os.path.exists(model_path):
            with open(model_path, "rb") as f:
                self.model_data = pickle.load(f)
            log(f"Model loaded from {model_path}")
        else:
            self.model_data = None
            log(f"No model at {model_path} - running in capture-only mode", "WARN")

    def reload_if_changed(self):
        """Picks up model/threshold changes made from the dashboard without a restart."""
        try:
            with open("config/config.yml") as f:
                fresh = yaml.safe_load(f)
        except Exception:
            return

        model_cfg = fresh.get("model", {})
        new_path = model_cfg.get("path", self.model_path)
        if new_path != self.model_path:
            if os.path.exists(new_path):
                self._load_model(new_path)
                self.model_path = new_path
                log(f"Switched active model to {new_path}", "STARTUP")
            else:
                log(f"Configured model {new_path} not found - keeping {self.model_path}", "WARN")

        new_threshold = model_cfg.get("alert_threshold", self._alert_threshold)
        if new_threshold != self._alert_threshold:
            self._alert_threshold = new_threshold

    def on_window(self, features, breakdown=None):
        row_id = database.insert_monitor(features, top_talkers=breakdown)
        if self.model_data:
            self.run_inference(features, row_id, breakdown)

    def compute_attribution(self, features):
        """Per-feature z-scores against the training baseline (scaler mean/std), sorted by |z| desc."""
        scaler = self.model_data["scaler"]
        attribution = []
        for i, col in enumerate(FEATURE_COLUMNS):
            mean = float(scaler.mean_[i])
            std = float(scaler.scale_[i]) or 1.0
            value = features[col]
            z = (value - mean) / std
            attribution.append({
                "feature": col,
                "value": value,
                "baseline_mean": mean,
                "baseline_std": std,
                "z_score": z,
            })
        attribution.sort(key=lambda a: -abs(a["z_score"]))
        return attribution

    def run_inference(self, features, row_id, breakdown=None):
        scaler = self.model_data["scaler"]
        model = self.model_data["model"]
        X = pd.DataFrame([[features[k] for k in FEATURE_COLUMNS]], columns=FEATURE_COLUMNS)
        X_scaled = scaler.transform(X)
        score = float(model.decision_function(X_scaled)[0])
        database.update_monitor_score(row_id, score)
        if score < self._alert_threshold:
            log(f"Anomaly detected! Score: {score:.4f}", "ALERT")
            attribution = self.compute_attribution(features)
            database.insert_alert(features, score, attribution=attribution, top_talkers=breakdown)

    def run(self):
        log("Capturing traffic started", "STARTUP")
        capture_traffic(self.on_window, self.window)
