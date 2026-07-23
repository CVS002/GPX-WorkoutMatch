"""Background maintenance jobs — the one-click version of references/maintenance.md.

Each job runs one of the engine's builder scripts with cwd set to the engine root
so their `data/history` and `data/cache` paths resolve to the app's own files.
Output streams into an in-memory log the UI polls. Single-user, local — a plain
thread per job is enough (no queue/broker).
"""
import sys
import threading
import subprocess
from datetime import datetime

from . import config
from . import icu

HISTORY_DIR = config.DATA_DIR / "history"

# Dense basemap: arterial + residential + cycling infrastructure
# (cycleway/path/track). build_street_cache also matches the _link variants and
# tags each way cycle|road so the map can style cycleways distinctly. (service is
# left out on purpose — driveways/parking aisles would balloon the regional cache.)
STREET_CLASSES = "primary,secondary,tertiary,unclassified,residential,living_street,cycleway,track,path"

_JOBS: dict[str, dict] = {}
_LOCK = threading.Lock()
_SEQ = 0

# kind -> (label, [script, *args]) run with cwd = ENGINE_ROOT
COMMANDS = {
    "road_db":      ("Rebuild road-knowledge DB", ["build_road_db.py", "data/history"]),
    "effort_db":    ("Rebuild effort-corridor DB", ["build_effort_db.py", "data/history"]),
    "osm_hazards":  ("Rebuild OSM hazard cache (60 km)", ["build_osm_cache.py", "--radius-km", "60"]),
    "streets":      ("Rebuild dense street basemap", ["build_street_cache.py", "--classes", STREET_CLASSES]),
    "bank":         ("Refresh workout bank", ["build_workout_bank.py"]),
}


def _new_job(label: str) -> str:
    global _SEQ
    with _LOCK:
        _SEQ += 1
        jid = f"job{_SEQ}"
        _JOBS[jid] = {"id": jid, "label": label, "status": "running", "log": [],
                      "started": datetime.now().isoformat(timespec="seconds"),
                      "finished": None, "error": None}
    return jid


def _log(jid: str, line: str):
    with _LOCK:
        _JOBS[jid]["log"].append(line.rstrip())


def _finish(jid: str, error: str | None = None):
    with _LOCK:
        _JOBS[jid]["status"] = "error" if error else "done"
        _JOBS[jid]["error"] = error
        _JOBS[jid]["finished"] = datetime.now().isoformat(timespec="seconds")


def status(jid: str | None = None):
    with _LOCK:
        if jid:
            return _JOBS.get(jid)
        return sorted(_JOBS.values(), key=lambda j: j["id"], reverse=True)


def _run_cmd(jid: str, script_args: list[str]):
    cmd = [sys.executable, str(config.ENGINE_DIR / script_args[0])] + script_args[1:]
    _log(jid, "$ " + " ".join(script_args))
    try:
        # cwd = the vendored engine root so `data/history` / `data/cache` resolve
        # to the app's own copies.
        proc = subprocess.Popen(cmd, cwd=str(config.ENGINE_ROOT), stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, bufsize=1)
        for line in proc.stdout:
            _log(jid, line)
        proc.wait()
        return proc.returncode
    except Exception as e:  # noqa: BLE001
        _log(jid, f"error: {type(e).__name__}: {e}")
        return 1


def start(kind: str) -> str:
    """Run a single builder in the background. Returns the job id."""
    if kind not in COMMANDS:
        raise ValueError(f"unknown job kind: {kind}")
    label, script_args = COMMANDS[kind]
    jid = _new_job(label)

    def worker():
        rc = _run_cmd(jid, script_args)
        _finish(jid, None if rc == 0 else f"exit code {rc}")

    threading.Thread(target=worker, daemon=True).start()
    return jid


def start_history_refresh(days: int = 760, max_rides: int = 1200) -> str:
    """Download recent-ride GPX into data/history (GPX, never streams — longitude
    bug), then rebuild the road + effort caches so new roads are learned."""
    jid = _new_job(f"Refresh ride history ({days} d) + rebuild road/effort DB")

    def worker():
        try:
            HISTORY_DIR.mkdir(parents=True, exist_ok=True)
            _log(jid, f"listing activities (last {days} d)...")
            acts = icu.recent_activities(days=days)
            rides = [a for a in acts if a.get("type") == "Ride"
                     and (a.get("distance") or a.get("distance_meters"))][:max_rides]
            _log(jid, f"{len(rides)} GPS rides to consider")
            got = skipped = 0
            for a in rides:
                aid = a.get("id")
                dest = HISTORY_DIR / f"{aid}.gpx"
                # skip only files already produced by the power-aware (v2) builder;
                # re-pull anything downloaded by the older power-less builder.
                if dest.exists() and b"workout-designer/2" in dest.read_bytes()[:200]:
                    skipped += 1
                    continue
                try:
                    dest.write_bytes(icu.download_gpx(aid, a.get("start_date_local") or a.get("start_date")))
                    got += 1
                    if got % 10 == 0:
                        _log(jid, f"  downloaded {got}...")
                except Exception as e:  # noqa: BLE001
                    _log(jid, f"  skip {aid}: {type(e).__name__}")
            _log(jid, f"downloaded {got}, already had {skipped}")
        except Exception as e:  # noqa: BLE001
            _finish(jid, f"history download failed: {e}")
            return
        rc1 = _run_cmd(jid, COMMANDS["road_db"][1])
        rc2 = _run_cmd(jid, COMMANDS["effort_db"][1])
        _finish(jid, None if rc1 == 0 and rc2 == 0 else "a rebuild step failed")

    threading.Thread(target=worker, daemon=True).start()
    return jid


# ------------------------------------------------------------ dossier (L4) ---
def append_known_roads(entries: list[dict]):
    """Append athlete-confirmed road corrections to references/known-roads.md so
    future routes start already-corrected (Layer 4 outranks the inferred layers)."""
    path = config.KNOWN_ROADS
    if not entries:
        return
    stamp = datetime.now().strftime("%Y-%m-%d")
    lines = [f"\n### App corrections {stamp}\n"]
    for e in entries:
        km = e.get("km")
        note = e.get("note", "I ride through this / not a real stop")
        lines.append(f"- km {km}: {note}")
    with open(path, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
