"""intervals.icu REST client (replaces the MCP connector at runtime).

Auth is HTTP Basic with username the literal string "API_KEY" and password the
athlete's personal key (intervals.icu -> Settings -> Developer). Endpoints follow
https://intervals.icu/api-docs.html ; the field names used by create_event mirror
what the MCP `icu_create_event` sent, and are the ones to re-verify against the
live API on first run (M2 in the plan).

Every call retries once, then surfaces a clean IcuError so the UI can degrade
gracefully ("proceeding with reduced context") instead of crashing.
"""
from datetime import date, timedelta

import httpx

from . import config


class IcuError(RuntimeError):
    pass


def _auth():
    return httpx.BasicAuth("API_KEY", config.ICU_API_KEY)


def _get(path: str, params: dict | None = None):
    if not config.icu_configured():
        raise IcuError("intervals.icu not configured — set ICU_API_KEY and "
                       "ICU_ATHLETE_ID in .env")
    url = f"{config.ICU_BASE}/api/v1{path}"
    last = None
    for _ in range(2):
        try:
            r = httpx.get(url, params=params, auth=_auth(), timeout=30)
            if r.status_code == 401:
                raise IcuError("intervals.icu rejected the API key (401)")
            r.raise_for_status()
            return r.json()
        except (httpx.HTTPError, ValueError) as e:  # noqa: PERF203
            last = e
    raise IcuError(f"intervals.icu request failed: {type(last).__name__}: {last}")


def _post(path: str, body: dict):
    if not config.icu_configured():
        raise IcuError("intervals.icu not configured")
    url = f"{config.ICU_BASE}/api/v1{path}"
    try:
        r = httpx.post(url, json=body, auth=_auth(), timeout=30)
        if r.status_code == 401:
            raise IcuError("intervals.icu rejected the API key (401)")
        r.raise_for_status()
        return r.json()
    except (httpx.HTTPError, ValueError) as e:
        raise IcuError(f"intervals.icu create failed: {type(e).__name__}: {e}")


def _aid():
    return config.ICU_ATHLETE_ID


# ------------------------------------------------------------------- reads ---
def recent_activities(days: int = 14) -> list[dict]:
    newest = date.today()
    oldest = newest - timedelta(days=days)
    data = _get(f"/athlete/{_aid()}/activities",
                {"oldest": oldest.isoformat(), "newest": newest.isoformat()})
    return data if isinstance(data, list) else data.get("activities", [])


def fitness() -> dict:
    """Latest CTL/ATL/TSB from the wellness feed. TSB = CTL - ATL."""
    newest = date.today()
    oldest = newest - timedelta(days=7)
    data = _get(f"/athlete/{_aid()}/wellness",
                {"oldest": oldest.isoformat(), "newest": newest.isoformat()})
    rows = data if isinstance(data, list) else data.get("wellness", [])
    rows = [w for w in rows if w.get("ctl") is not None]
    if not rows:
        return {"ctl": None, "atl": None, "tsb": None}
    rows.sort(key=lambda w: w.get("id") or w.get("date") or "")
    latest = rows[-1]
    ctl, atl = latest.get("ctl"), latest.get("atl")
    tsb = round(ctl - atl, 1) if ctl is not None and atl is not None else None
    return {"ctl": round(ctl, 1) if ctl else None,
            "atl": round(atl, 1) if atl else None, "tsb": tsb,
            "date": latest.get("id") or latest.get("date")}


def sport_settings() -> dict:
    """Ride FTP / FTHR. Tries the athlete record's sportSettings, falls back to
    the dedicated endpoint."""
    try:
        ath = _get(f"/athlete/{_aid()}")
        ss = ath.get("sportSettings") or ath.get("sport_settings") or []
    except IcuError:
        ss = _get(f"/athlete/{_aid()}/sport-settings")
    ride = None
    for s in ss if isinstance(ss, list) else []:
        types = s.get("types") or [s.get("type")]
        if types and any(t in ("Ride", "VirtualRide") for t in types if t):
            ride = s
            break
    ride = ride or (ss[0] if ss else {})
    ftp = ride.get("ftp") or ride.get("ftp_watts")
    fthr = ride.get("lthr") or ride.get("fthr_bpm") or ride.get("fthr")
    return {"ftp": ftp, "fthr": fthr}


def events(around: str, span_days: int = 3) -> list[dict]:
    """Calendar events within +/- span_days of a YYYY-MM-DD date."""
    d = date.fromisoformat(around)
    data = _get(f"/athlete/{_aid()}/events",
                {"oldest": (d - timedelta(days=span_days)).isoformat(),
                 "newest": (d + timedelta(days=span_days)).isoformat()})
    return data if isinstance(data, list) else data.get("events", [])


def get_event(event_id) -> dict:
    return _get(f"/athlete/{_aid()}/events/{event_id}")


# ------------------------------------------------------------------ writes ---
def create_workout(start_date: str, name: str, description: str,
                   distance_meters: float | None = None,
                   duration_seconds: int | None = None) -> dict:
    body = {
        "category": "WORKOUT",
        "start_date_local": f"{start_date}T00:00:00",
        "type": "Ride",
        "name": name,
        "description": description,
    }
    if distance_meters:
        body["distance"] = round(distance_meters)
    if duration_seconds:
        body["moving_time"] = int(duration_seconds)
    return _post(f"/athlete/{_aid()}/events", body)


def download_gpx(activity_id, start_local: str | None = None) -> bytes:
    """Reconstruct a builder-compatible GPX for a ride, for the cache rebuilds.

    intervals.icu has no /gpx export endpoint (404), and the `latlng` STREAM
    returns latitude only (longitude dropped — the long-standing bug). The route
    geometry WITH longitude lives in the /map endpoint's `latlngs`; time / HR /
    speed / altitude come from /streams. We fuse them into the same GPX shape the
    engine's builders parse: <trkpt> with <ele>/<time>/<speed>/<hr> children and a
    <link href=".../{id}"> so ride dedup by activity id still works.
    """
    from datetime import datetime, timedelta
    base = config.ICU_BASE
    mp = httpx.get(f"{base}/api/v1/activity/{activity_id}/map", auth=_auth(), timeout=60)
    mp.raise_for_status()
    latlngs = mp.json().get("latlngs") or []
    if len(latlngs) < 2:
        raise IcuError(f"{activity_id}: no GPS geometry")
    st = httpx.get(f"{base}/api/v1/activity/{activity_id}/streams", auth=_auth(), timeout=60,
                   params={"types": "time,heartrate,velocity_smooth,altitude,watts"})
    st.raise_for_status()
    S = {s["type"]: (s.get("data") or []) for s in st.json()}
    tstream, hr, vel, alt = S.get("time"), S.get("heartrate", []), S.get("velocity_smooth", []), S.get("altitude", [])
    pwr = S.get("watts", [])
    n = min(len(latlngs), len(tstream) if tstream else len(latlngs))

    base_dt = datetime(2020, 1, 1)
    if start_local:
        s = start_local.replace("Z", "").split("+")[0].split(".")[0][:19]
        try:
            base_dt = datetime.strptime(s, "%Y-%m-%dT%H:%M:%S")
        except ValueError:
            pass

    # creator carries a schema version so a re-refresh can tell power-aware GPX
    # (v2, fetches the watts stream) from the older power-less files and re-pull them.
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<gpx version="1.1" creator="workout-designer/2" xmlns="http://www.topografix.com/GPX/1/1">',
           '<trk>', f'<link href="https://intervals.icu/activities/{activity_id}"></link>', '<trkseg>']
    for i in range(n):
        ll = latlngs[i]
        if not ll or not isinstance(ll, (list, tuple)) or len(ll) < 2:
            continue                       # GPS dropout — skip this sample
        lat, lon = ll[0], ll[1]
        tv = tstream[i] if tstream and i < len(tstream) else None
        secs = float(tv) if tv is not None else i
        t = (base_dt + timedelta(seconds=secs)).strftime("%Y-%m-%dT%H:%M:%SZ")
        row = [f'<trkpt lat="{lat:.6f}" lon="{lon:.6f}">']
        if i < len(alt) and alt[i] is not None:
            row.append(f'<ele>{alt[i]:.1f}</ele>')
        row.append(f'<time>{t}</time>')
        if i < len(vel) and vel[i] is not None:
            row.append(f'<speed>{vel[i]:.3f}</speed>')
        if i < len(hr) and hr[i] is not None:
            row.append(f'<hr>{int(hr[i])}</hr>')
        if i < len(pwr) and pwr[i] is not None:
            row.append(f'<power>{int(pwr[i])}</power>')
        row.append('</trkpt>')
        out.append(''.join(row))
    out += ['</trkseg>', '</trk>', '</gpx>']
    return "\n".join(out).encode("utf-8")
