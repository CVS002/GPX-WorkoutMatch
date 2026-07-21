"""Configuration: paths + .env loading (no external deps).

The app SHARES the skill's engine scripts, data caches, references dossier and
map template rather than copying them, so a cache rebuilt here is immediately
current in Claude Code and vice-versa. Every path is overridable via .env.
"""
import os
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent


def _load_env():
    """Minimal .env parser (KEY=VALUE, # comments). Avoids a python-dotenv dep."""
    env_path = APP_ROOT / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key, val = key.strip(), val.strip().strip('"').strip("'")
        os.environ.setdefault(key, val)


_load_env()


def _p(env_key, default):
    return Path(os.environ.get(env_key, default)).expanduser()


# --- Vendored engine (the app owns its own copy; see SYNC.md) ---
# The app runs entirely off engine/ under APP_ROOT so its caches can grow
# independently of the packaged skill. SKILL_DIR is only the SYNC SOURCE for the
# "sync from skill" maintenance action — never read during a normal session.
ENGINE_ROOT = _p("ENGINE_ROOT", str(APP_ROOT / "engine"))
ENGINE_DIR = _p("ENGINE_DIR", str(ENGINE_ROOT / "scripts"))
DATA_DIR = _p("DATA_DIR", str(ENGINE_ROOT / "data"))
CACHE_DIR = _p("CACHE_DIR", str(DATA_DIR / "cache"))
ASSETS_DIR = _p("ASSETS_DIR", str(ENGINE_ROOT / "assets"))
REFERENCES_DIR = _p("REFERENCES_DIR", str(ENGINE_ROOT / "references"))

# External skill install — used only as the sync source (code + optional caches).
SKILL_DIR = _p("SKILL_DIR",
               str(Path.home() / ".claude" / "skills" / "gpx-workout-designer-v2"))

ROAD_DB = CACHE_DIR / "road_db.json"
EFFORT_DB = CACHE_DIR / "effort_db.json"
OSM_HAZARDS = CACHE_DIR / "osm_hazards.json"
OSM_STREETS = CACHE_DIR / "osm_streets.json"
WORKOUT_BANK = CACHE_DIR / "workout_bank.json"
KNOWN_ROADS = REFERENCES_DIR / "known-roads.md"
MAP_TEMPLATE = ASSETS_DIR / "map_widget_template.html"

# --- App working data (uploads, generated maps, per-route state) ---
APP_DATA = _p("APP_DATA", str(APP_ROOT / "appdata"))
ROUTES_DIR = APP_DATA / "routes"
ROUTES_DIR.mkdir(parents=True, exist_ok=True)

# --- intervals.icu ---
ICU_BASE = os.environ.get("ICU_BASE", "https://intervals.icu").rstrip("/")
ICU_API_KEY = os.environ.get("ICU_API_KEY", "")
ICU_ATHLETE_ID = os.environ.get("ICU_ATHLETE_ID", "0")

# --- Server ---
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8712"))

# --- Design constants ---
REF_SPEED_KMH = float(os.environ.get("REF_SPEED_KMH", "30"))   # min<->km reference
KM_PER_MIN = REF_SPEED_KMH / 60.0
BUFFER_KM = float(os.environ.get("BUFFER_KM", "5"))            # lap-button padding


def icu_configured() -> bool:
    return bool(ICU_API_KEY) and ICU_ATHLETE_ID not in ("", "0")


def missing_engine_bits() -> list[str]:
    """Human-readable list of any shared skill files that aren't where we expect,
    so the UI can tell the user to fix SKILL_DIR instead of failing cryptically."""
    checks = {
        "engine scripts": ENGINE_DIR / "analyze_gpx.py",
        "map template": MAP_TEMPLATE,
        "workout bank": WORKOUT_BANK,
    }
    return [name for name, path in checks.items() if not path.exists()]
