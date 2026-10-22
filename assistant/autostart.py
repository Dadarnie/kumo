"""Start Raphael when you log in to Windows (a shortcut in your Startup folder).

    .\\.venv\\Scripts\\python.exe autostart.py on       add the shortcut
    .\\.venv\\Scripts\\python.exe autostart.py off      remove it
    .\\.venv\\Scripts\\python.exe autostart.py          show whether it's on
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def _startup_dir():
    out = subprocess.run(["powershell", "-NoProfile", "-Command", "[Environment]::GetFolderPath('Startup')"],
                         capture_output=True, text=True).stdout.strip()
    return Path(out)


LINK = _startup_dir() / "Raphael.lnk"


def on():
    ps = ("$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:RAPHAEL_LINK);"
          "$s.TargetPath = $env:RAPHAEL_PY; $s.Arguments = 'chat.py --ui'; $s.WorkingDirectory = $env:RAPHAEL_DIR;"
          "$s.IconLocation = $env:RAPHAEL_ICON; $s.WindowStyle = 7;"  # 7 = start the console minimized
          "$s.Description = 'Raphael local voice assistant'; $s.Save()")
    env = {"RAPHAEL_LINK": str(LINK), "RAPHAEL_PY": str(ROOT / ".venv" / "Scripts" / "python.exe"),
           "RAPHAEL_DIR": str(ROOT), "RAPHAEL_ICON": str(ROOT / "raphael.ico")}
    import os
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], env={**os.environ, **env}, check=True)
    print(f"On: Raphael starts at login ({LINK}).")


def off():
    LINK.unlink(missing_ok=True)
    print("Off: Raphael will not start at login.")


if __name__ == "__main__":
    {"on": on, "off": off}.get(sys.argv[1] if len(sys.argv) > 1 else "",
                               lambda: print(f"Auto-start is {'ON' if LINK.exists() else 'OFF'} ({LINK})"))()
