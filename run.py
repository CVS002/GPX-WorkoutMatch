"""Launch the local GPX Workout Designer: start uvicorn and open the browser.

    python run.py
"""
import threading
import webbrowser

import uvicorn

from server import config


def _open_browser():
    webbrowser.open(f"http://{config.HOST}:{config.PORT}/")


if __name__ == "__main__":
    missing = config.missing_engine_bits()
    if missing:
        print("WARNING: engine files not found:", ", ".join(missing))
        print(f"  Expected under {config.ENGINE_ROOT}")
    print(f"GPX Workout Designer -> http://{config.HOST}:{config.PORT}/")
    print(f"  intervals.icu: {'configured' if config.icu_configured() else 'NOT configured (.env)'}")
    threading.Timer(1.2, _open_browser).start()
    uvicorn.run("server.main:app", host=config.HOST, port=config.PORT, reload=False)
