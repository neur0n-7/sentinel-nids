#!/usr/bin/env python3
"""
Sentinel model training tool.
github.com/neur0n-7/sentinel-nids

Usage:
  # Collect training data for 45 minutes
  python src/ml.py collect --profile home --minutes 45

  # Alternatively collect until ctrl c
  python src/ml.py collect --profile home

  # Train model on profile data and save to models/homeModel.pkl
  python src/ml.py train --profile home --file homeModel
"""
import argparse
import os
import pickle
import yaml
import pandas as pd
from rich.console import Console
import sys
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler


import database
from backend import FEATURE_COLUMNS, capture_traffic

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


def cmd_collect(args):
    database.init_db()
    profile = args.profile
    existing = database.profile_row_count(profile)
    if existing:
        answer = input(f"Profile '{profile}' already has {existing} rows. Append? [y/N] ").strip().lower()
        if answer != "y":
            print("Aborted.")
            return

    duration = f"{args.minutes} minutes" if args.minutes else "until Ctrl+C"
    action = "Appending to" if existing else "Creating"
    print(f"{action} profile '{profile}' ({duration})")

    def on_window(features, breakdown=None):
        database.insert_training(features, profile)
        print(
            f"[{profile}] flows={features['active_flows']} | "
            f"packets={features['total_packets']} | bytes={features['total_bytes']}"
        )

    try:
        capture_traffic(on_window, CONFIG["aggregation"]["window"], minutes=args.minutes)
    except KeyboardInterrupt:
        pass

    total = database.profile_row_count(profile)
    print(f"\nDone. Profile '{profile}' now has {total} rows.")


def cmd_train(args):
    database.init_db()
    rows = database.get_profile_features(args.profile)
    if not rows:
        print(f"No data found for profile '{args.profile}'")
        return

    df = pd.DataFrame(rows, columns=FEATURE_COLUMNS)
    print(f"[+] Loaded {len(df)} rows from profile '{args.profile}'")
    print("[+] Training Isolation Forest...")

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(df)

    model = IsolationForest(contamination=CONFIG["model"]["contamination"], random_state=42)
    model.fit(X_scaled)

    os.makedirs("models", exist_ok=True)
    model_path = f"models/{args.file}.pkl"
    with open(model_path, "wb") as f:
        pickle.dump({"model": model, "scaler": scaler}, f)

    print(f"\nModel saved to {model_path}")
    print("Training complete")


def main():
    parser = argparse.ArgumentParser(description="NIDS ML training tool")
    sub = parser.add_subparsers(dest="command", required=True)

    collect_p = sub.add_parser("collect", help="Capture traffic into a named profile")
    collect_p.add_argument("--profile", required=True, help="Profile name (e.g. home, office)")
    collect_p.add_argument(
        "--minutes", type=float, default=None,
        help="Duration in minutes (omit to run until Ctrl+C)",
    )

    train_p = sub.add_parser("train", help="Train Isolation Forest on a profile")
    train_p.add_argument("--profile", required=True, help="Profile name to train on")
    train_p.add_argument(
        "--file", required=True,
        help="Output model file name - saved as models/<name>.pkl",
    )

    args = parser.parse_args()
    if args.command == "collect":
        cmd_collect(args)
    elif args.command == "train":
        cmd_train(args)


if __name__ == "__main__":
    main()
