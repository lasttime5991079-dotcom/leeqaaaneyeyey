
#!/usr/bin/env python3
"""Original authorized webpage -> Chrome -> OBS -> selected OK.ru stream.

WARP ON uses Cloudflare's *local proxy for Chrome only*; OBS and GitHub
network traffic are not proxied. Never bypasses DRM or website restrictions.
"""

import json
import os
import secrets
import shutil
import subprocess
import time
from pathlib import Path
from urllib.parse import urlparse

import obsws_python as obs

# User-requested hardcoded OK.ru publishing keys.
# SECURITY: GitHub repository must be PRIVATE. Rotate keys if exposed.
OKRU_KEYS = {
    "s2.1": "14204490948143_14846603495983_kzevn36tii",
    "s2.2": "14204506742319_14846634494511_ta2rxyg2oy",
    "s2.3": "14204523322927_14846661233199_foqb3q7zb4",
    "s2.4": "14204540034607_14846689085999_gjejdie4uy",
    "s2.5": "14204555304495_14846715497007_zdanghuxzu",
    "s2.6": "14204565200431_14846734371375_ap3bqpabpu",
    "s2.7": "14204577259055_14846756194863_3ecad2535u",
    "s2.8": "14204592528943_14846785227311_4hjl46y62e",
    "s2.9": "14204602621487_14846802594351_ilnp6lxekq",
    "s2.10": "14206184136239_14849618610735_ihnbx7hkoi",
}

ROOT = Path(__file__).resolve().parents[1]
DIAG = ROOT / "diagnostics"
DISPLAY = ":99"
SCENE = "Webpage Capture"
SCREEN = "Browser Display"
AUDIO = "Browser Audio"


def log(message):
    print(message, flush=True)


def execute(args, *, check=True, **kwargs):
    return subprocess.run(args, check=check, **kwargs)


def spawn(args, log_name, **kwargs):
    with (DIAG / log_name).open("w", encoding="utf-8") as fd:
        return subprocess.Popen(args, stdout=fd, stderr=subprocess.STDOUT, **kwargs)


def wait_until(check, label, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.5)
    raise RuntimeError(f"Timeout waiting for {label}")


def show_log(name, last=75):
    path = DIAG / name
    if path.exists():
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        log(f"----- Last {min(last, len(lines))} lines of {name} -----")
        for line in lines[-last:]:
            # No RTMP URL or publishing secret is printed by this script.
            # The full diagnostic artifact is sensitive; keep repo private.
            for key in OKRU_KEYS.values():
                line = line.replace(key, "[REDACTED_OKRU_KEY]")
            log(line)


def config():
    url = os.getenv("PAGE_URL", "").strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("https", "http") or not parsed.hostname:
        raise ValueError("page_url must be a complete http(s) webpage URL")
    if parsed.path.lower().endswith((".m3u8", ".mpd")):
        raise ValueError("Use original webpage URL, not a video playlist")
    mode = os.getenv("CAPTURE_MODE", "preview").strip().lower()
    if mode not in ("preview", "stream"):
        raise ValueError("mode must be preview or stream")
    slot = os.getenv("OK_STREAM_SLOT", "s2.1").strip()
    if slot not in OKRU_KEYS:
        raise ValueError("Select s2.1 through s2.10")
    hours = int(os.getenv("CAPTURE_HOURS", "1"))
    minutes = int(os.getenv("CAPTURE_EXTRA_MINUTES", "20"))
    if hours < 0 or hours > 5 or minutes < 0 or minutes > 59:
        raise ValueError("hours must be 0-5; minutes must be 0-59")
    duration = 60 * hours + minutes
    if mode == "stream" and not 1 <= duration <= 300:
        raise ValueError("Total stream duration must be 1-300 minutes")
    warp = os.getenv("CLOUDFLARE_WARP", "off").strip().lower()
    if warp not in ("on", "off"):
        raise ValueError("cloudflare_warp must be on or off")
    server = os.getenv("OK_RTMP_SERVER", "").strip()
    if mode == "stream":
        dest = urlparse(server)
        if dest.scheme not in ("rtmp", "rtmps") or not dest.hostname:
            raise ValueError("Set OK.ru RTMP(S) server URL in workflow input")
    log(f"Webpage host={parsed.hostname}, mode={mode}, OK.ru slot={slot}")
    log(f"Duration={hours}h {minutes}m ({duration} total minutes), WARP={warp}")
    return url, mode, slot, duration, warp, server


def linux_desktop():
    os.environ["DISPLAY"] = DISPLAY
    os.environ["QT_QPA_PLATFORM"] = "xcb"
    os.environ["LIBGL_ALWAYS_SOFTWARE"] = "1"
    os.environ["QT_X11_NO_MITSHM"] = "1"
    runtime = Path(os.environ.get("XDG_RUNTIME_DIR") or "/tmp/obs-github-runtime")
    runtime.mkdir(parents=True, exist_ok=True)
    runtime.chmod(0o700)
    os.environ["XDG_RUNTIME_DIR"] = str(runtime)
    spawn(["Xvfb", DISPLAY, "-screen", "0", "1280x720x24", "+extension", "GLX",
           "+render", "-noreset", "-nolisten", "tcp"], "xvfb.log")
    wait_until(lambda: execute(["xdpyinfo", "-display", DISPLAY], check=False,
                               stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL).returncode == 0, "Xvfb")
    spawn(["openbox", "--sm-disable"], "openbox.log")
    info = execute(["glxinfo", "-B"], check=False, capture_output=True, text=True)
    (DIAG / "graphics.txt").write_text(info.stdout + info.stderr, encoding="utf-8")
    if info.returncode != 0:
        log("WARNING: glxinfo failed; OBS may lack working OpenGL support")
    execute(["pulseaudio", "--start", "--exit-idle-time=-1"], check=False)
    wait_until(lambda: execute(["pactl", "info"], check=False,
                               stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL).returncode == 0, "PulseAudio")
    sinks = execute(["pactl", "list", "short", "sinks"],
                    capture_output=True, text=True).stdout
    if "browser_audio" not in sinks:
        execute(["pactl", "load-module", "module-null-sink", "sink_name=browser_audio",
                 "sink_properties=device.description=BrowserAudio"])
    execute(["pactl", "set-default-sink", "browser_audio"])
    log("Xvfb, Openbox, and PulseAudio initialized")


def prepare_obs():
    """Seed first-run config BEFORE starting OBS (no forced terminate/restart)."""
    base = Path.home() / ".config" / "obs-studio"
    profile = base / "basic" / "profiles" / "Auto"
    profile.mkdir(parents=True, exist_ok=True)
    (base / "basic" / "scenes").mkdir(parents=True, exist_ok=True)
    DIAG.mkdir(exist_ok=True)
    (Path.home() / "Videos").mkdir(exist_ok=True)

    (base / "user.ini").write_text(
        "[General]\nFirstRun=false\nConfirmOnExit=false\n"
        "[Basic]\nProfile=Auto\nProfileDir=Auto\n"
        "SceneCollection=Untitled\nSceneCollectionFile=Untitled\n"
        "[BasicWindow]\nWarnBeforeStoppingStream=false\n"
        "WarnBeforeStoppingRecord=false\n",
        encoding="utf-8",
    )
    (profile / "basic.ini").write_text(
        "[General]\nName=Auto\n"
        "[Video]\nBaseCX=1280\nBaseCY=720\nOutputCX=1280\nOutputCY=720\nFPSCommon=30\n"
        "[Audio]\nSampleRate=48000\nChannelSetup=Stereo\n"
        "[Output]\nMode=Simple\n"
        "[SimpleOutput]\nVBitrate=2500\nABitrate=160\nStreamEncoder=x264\n"
        f"FilePath={DIAG}\nRecFormat=mkv\nRecEncoder=x264\n",
        encoding="utf-8",
    )
    password = secrets.token_urlsafe(24)
    websocket = base / "plugin_config" / "obs-websocket" / "config.json"
    websocket.parent.mkdir(parents=True, exist_ok=True)
    websocket.write_text(json.dumps({
        "server_enabled": True,
        "server_port": 4455,
        "auth_required": True,
        "server_password": password,
        "first_load": False,
        "alerts_enabled": False,
    }), encoding="utf-8")
    return password


def launch_obs():
    password = prepare_obs()
    args = ["obs", "--disable-missing-files-check", "--profile", "Auto",
            "--websocket_port", "4455", "--websocket_password", password,
            "--websocketipv4only"]
    process = spawn(args, "obs.log")
    client = None
    failure = None
    for attempt in range(45):
        if process.poll() is not None:
            failure = f"OBS exited with code {process.returncode}"
            break
        try:
            client = obs.ReqClient(host="127.0.0.1", port=4455,
                                   password=password, timeout=2)
            version = client.get_version()
            log(f"OBS WebSocket is connected (OBS {getattr(version, 'obs_version', '?')})")
            break
        except Exception as exc:
            failure = f"port 4455 not ready ({type(exc).__name__})"
            if attempt in (5, 15, 30):
                log(f"Waiting for OBS WebSocket... {attempt + 1}/45")
            time.sleep(2)
    if client is None:
        log(f"ERROR: {failure}")
        show_log("obs.log", 100)
        try:
            latest = sorted((Path.home() / ".config" / "obs-studio" / "logs").glob("*.txt"))
            if latest:
                destination = DIAG / "obs-native.log"
                shutil.copy2(latest[-1], destination)
                show_log("obs-native.log", 60)
        except Exception as exc:
            log(f"Could not copy native OBS log: {exc}")
        raise RuntimeError("OBS failed to start its WebSocket on port 4455. "
                           "Check log lines above and uploaded diagnostics.")
    return process, client


def obs_sources(client):
    kinds = set(client.get_input_kind_list().input_kinds)
    expected = {"xshm_input", "pulse_output_capture"}
    if not expected.issubset(kinds):
        raise RuntimeError(f"OBS lacks required Linux input sources: {expected - kinds}")
    # Check the screen/audio sources before adding them. The existing scene may
    # already exist because OBS creates default scenes for new profiles.
    scenes = {scene["sceneName"] for scene in client.get_scene_list().scenes}
    if SCENE not in scenes:
        client.create_scene(SCENE)
    client.set_current_program_scene(SCENE)
    inputs = {item["inputName"] for item in client.get_input_list().inputs}
    if SCREEN not in inputs:
        client.create_input(SCENE, SCREEN, "xshm_input", {"screen": 0}, True)
    if AUDIO not in inputs:
        client.create_input(SCENE, AUDIO, "pulse_output_capture",
                            {"device": "browser_audio.monitor"}, True)
    log("OBS video source=XSHM screen 0; audio=browser_audio.monitor")


def start_chrome(url, warp):
    cmd = ["google-chrome", "--no-first-run", "--no-default-browser-check",
           "--disable-dev-shm-usage", "--password-store=basic",
           "--autoplay-policy=no-user-gesture-required",
           "--user-data-dir=/tmp/authorized-obs-chrome",
           "--window-size=1280,720", "--kiosk"]
    if warp == "on":
        cmd += ["--proxy-server=socks5://127.0.0.1:40000", "--disable-quic"]
    cmd.append(url)
    env = os.environ.copy()
    env["PULSE_SINK"] = "browser_audio"
    chrome = spawn(cmd, "chrome.log", env=env)
    time.sleep(15)
    if chrome.poll() is not None:
        show_log("chrome.log")
        raise RuntimeError(f"Chrome exited early with code {chrome.returncode}")
    result = execute(["ffmpeg", "-y", "-loglevel", "error", "-f", "x11grab",
                      "-video_size", "1280x720", "-i", f"{DISPLAY}.0",
                      "-frames:v", "1", str(DIAG / "browser.png")], check=False,
                     capture_output=True, text=True)
    if result.returncode != 0:
        log("WARNING: browser screenshot failed: " + result.stderr[-400:])
    else:
        log("browser.png saved; inspect it for website playback errors")
    return chrome


def make_preview(client):
    try:
        client.set_record_directory(str(DIAG))
    except Exception as exc:
        log(f"Record directory request unavailable: {type(exc).__name__}; using OBS profile output directory")
    client.start_record()
    log("Recording 20-second OBS preview")
    time.sleep(20)
    output = getattr(client.stop_record(), "output_path", None)
    if not output or not Path(output).is_file():
        raise RuntimeError("OBS did not return a valid recording file")
    file_path = Path(output)
    if file_path.parent.resolve() != DIAG.resolve():
        shutil.copy2(file_path, DIAG / file_path.name)
    log(f"Preview recorded ({file_path.stat().st_size} bytes): {file_path.name}")
    log("IMPORTANT: preview file must be checked for actual moving video/audio")


def stream_okru(client, slot, server, seconds, obs_process, chrome_process):
    client.set_stream_service_settings("rtmp_custom", {
        "server": server, "key": OKRU_KEYS[slot]
    })
    client.start_stream()
    wait_until(lambda: client.get_stream_status().output_active,
               "OBS RTMP publishing", timeout=40)
    log(f"OBS streaming started to selected OK.ru slot {slot}")
    log("OBS output_active does NOT prove audience-visible OK.ru playback")
    started = time.monotonic()
    try:
        while time.monotonic() - started < seconds:
            if obs_process.poll() is not None or chrome_process.poll() is not None:
                raise RuntimeError("OBS or Chrome exited while streaming")
            status = client.get_stream_status()
            if not status.output_active:
                raise RuntimeError("OBS stream output became inactive")
            elapsed = int(time.monotonic() - started)
            log(f"OK.ru slot={slot}, encoder active, elapsed={elapsed}s/{seconds}s")
            time.sleep(min(10, max(0, seconds - (time.monotonic() - started))))
    finally:
        try:
            if client.get_stream_status().output_active:
                client.stop_stream()
        except Exception as exc:
            log(f"Could not stop stream cleanly: {type(exc).__name__}")


def main():
    DIAG.mkdir(parents=True, exist_ok=True)
    url, mode, slot, duration, warp, server = config()
    linux_desktop()
    obs_process, client = launch_obs()
    try:
        obs_sources(client)
        chrome_process = start_chrome(url, warp)
        if mode == "preview":
            make_preview(client)
        else:
            stream_okru(client, slot, server, duration * 60, obs_process, chrome_process)
        log("Capture workflow completed")
    except Exception:
        show_log("obs.log", 70)
        show_log("chrome.log", 30)
        raise
    finally:
        try:
            client.disconnect()
        except Exception:
            pass


if __name__ == "__main__":
    main()
