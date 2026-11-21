
#!/usr/bin/env python3
"""Authorized browser-page capture to OBS and a selected OK.ru stream.

The input is an ordinary webpage URL. This program does not extract HLS
playlists, bypass DRM, authenticate to websites, or circumvent access controls.
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

# IMPORTANT: These are LIVE PUBLISHING CREDENTIALS. Keep the repository PRIVATE.
# Replace / rotate these values if your keys have been exposed.
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

# Example endpoint only. Confirm the RTMP server in your OK.ru account.
EXAMPLE_OKRU_SERVER = "rtmp://vsu.mycdn.me/input"

ROOT = Path(__file__).resolve().parents[1]
DIAGNOSTICS = ROOT / "diagnostics"
DISPLAY = ":99"
SCENE = "Authorized Webpage"
SCREEN = "Chrome Screen"
AUDIO = "Chrome Audio"


def run(args, *, check=True, **kwargs):
    return subprocess.run(args, check=check, **kwargs)


def bg(args, log_name, **kwargs):
    with (DIAGNOSTICS / log_name).open("w", encoding="utf-8") as log:
        return subprocess.Popen(
            args, stdout=log, stderr=subprocess.STDOUT, **kwargs
        )


def wait_for(condition, name, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.5)
    raise RuntimeError(f"Timed out waiting for {name}; review diagnostics")


def input_config():
    url = os.getenv("PAGE_URL", "").strip()
    parsed = urlparse(url)

    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("PAGE_URL must be a full http:// or https:// webpage URL")

    if parsed.path.lower().endswith((".m3u8", ".mpd")):
        raise ValueError("Use the original webpage URL, not a playlist URL")

    mode = os.getenv("CAPTURE_MODE", "preview").strip()
    if mode not in ("preview", "stream"):
        raise ValueError("CAPTURE_MODE must be preview or stream")

    slot = os.getenv("OK_STREAM_SLOT", "s2.1").strip()
    if slot not in OKRU_KEYS:
        raise ValueError(
            f"Unknown OK.ru slot {slot!r}; choose s2.1 ... s2.10"
        )

    minutes = int(os.getenv("CAPTURE_MINUTES", "15"))
    if not 1 <= minutes <= 300:
        raise ValueError("CAPTURE_MINUTES must be 1 through 300")

    server = os.getenv(
        "OK_RTMP_SERVER", EXAMPLE_OKRU_SERVER
    ).strip().rstrip("/")

    if mode == "stream":
        endpoint = urlparse(server)
        if endpoint.scheme not in ("rtmp", "rtmps") or not endpoint.netloc:
            raise ValueError(
                "OK_RTMP_SERVER must be the RTMP(S) server URL from OK.ru"
            )

    print(
        f"Mode: {mode}; OK.ru slot: {slot}; page hostname: {parsed.hostname}",
        flush=True,
    )
    print(
        "NOTE: A launched browser is not proof that protected content plays.",
        flush=True,
    )
    return url, mode, slot, minutes, server


def start_display():
    os.environ["DISPLAY"] = DISPLAY

    bg(
        ["Xvfb", DISPLAY, "-screen", "0", "1280x720x24", "-nolisten", "tcp"],
        "xvfb.log",
    )

    wait_for(
        lambda: run(
            ["xdpyinfo", "-display", DISPLAY],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode == 0,
        "Xvfb",
    )

    bg(["openbox", "--sm-disable"], "openbox.log")
    run(["pulseaudio", "--start", "--exit-idle-time=-1"], check=False)

    wait_for(
        lambda: run(
            ["pactl", "info"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode == 0,
        "PulseAudio",
    )

    sinks = run(
        ["pactl", "list", "short", "sinks"],
        capture_output=True,
        text=True,
    ).stdout

    if "browser_audio" not in sinks:
        run(
            [
                "pactl",
                "load-module",
                "module-null-sink",
                "sink_name=browser_audio",
                "sink_properties=device.description=BrowserAudio",
            ]
        )

    run(["pactl", "set-default-sink", "browser_audio"])
    print(
        "Xvfb display and PulseAudio browser_audio.monitor initialized",
        flush=True,
    )


def obs_proc():
    return bg(
        ["obs", "--disable-updater", "--disable-shutdown-check"],
        "obs.log",
    )


def start_obs():
    # Initialize OBS config on the first run.
    (Path.home() / "Videos").mkdir(exist_ok=True)

    first = obs_proc()
    time.sleep(8)
    first.terminate()

    try:
        first.wait(timeout=10)
    except subprocess.TimeoutExpired:
        first.kill()
        first.wait()

    config = (
        Path.home()
        / ".config/obs-studio/plugin_config/obs-websocket/config.json"
    )
    config.parent.mkdir(parents=True, exist_ok=True)

    try:
        data = json.loads(config.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        data = {}

    password = secrets.token_urlsafe(24)
    data.update(
        {
            "server_enabled": True,
            "server_port": 4455,
            "auth_required": True,
            "server_password": password,
            "first_load": False,
            "alerts_enabled": False,
        }
    )

    config.write_text(json.dumps(data, indent=2), encoding="utf-8")
    process = obs_proc()

    client = None
    for _ in range(70):
        if process.poll() is not None:
            raise RuntimeError(
                "OBS closed during startup; see diagnostics/obs.log"
            )

        try:
            candidate = obs.ReqClient(
                host="127.0.0.1",
                port=4455,
                password=password,
                timeout=2,
            )
            candidate.get_version()
            client = candidate
            break
        except Exception:
            time.sleep(1)

    if client is None:
        raise RuntimeError(
            "OBS WebSocket did not start; see diagnostics/obs.log"
        )

    return process, client


def configure_obs(client):
    available = set(client.get_input_kind_list().input_kinds)
    required = {"xshm_input", "pulse_output_capture"}

    if not required.issubset(available):
        raise RuntimeError(
            f"OBS missing source kinds: {sorted(required - available)}"
        )

    try:
        client.set_video_settings(
            fps_numerator=30,
            fps_denominator=1,
            base_width=1280,
            base_height=720,
            output_width=1280,
            output_height=720,
        )
    except Exception as exc:
        print(
            f"Warning: OBS video settings unchanged: {exc}",
            flush=True,
        )

    scenes = {
        x["sceneName"] for x in client.get_scene_list().scenes
    }

    if SCENE not in scenes:
        client.create_scene(SCENE)

    client.set_current_program_scene(SCENE)

    existing = {
        x["inputName"] for x in client.get_input_list().inputs
    }

    if SCREEN not in existing:
        client.create_input(
            SCENE,
            SCREEN,
            "xshm_input",
            {"screen": 0},
            True,
        )

    if AUDIO not in existing:
        client.create_input(
            SCENE,
            AUDIO,
            "pulse_output_capture",
            {"device": "browser_audio.monitor"},
            True,
        )

    print(
        "OBS scene configured with display and audio sources",
        flush=True,
    )


def launch_chrome(url):
    env = os.environ.copy()
    env["PULSE_SINK"] = "browser_audio"

    browser = bg(
        [
            "google-chrome",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-dev-shm-usage",
            "--password-store=basic",
            "--user-data-dir=/tmp/obs-authorized-browser",
            "--window-size=1280,720",
            "--kiosk",
            url,
        ],
        "chrome.log",
        env=env,
    )

    time.sleep(12)

    if browser.poll() is not None:
        raise RuntimeError(
            "Chrome exited unexpectedly; see diagnostics/chrome.log"
        )

    run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-f",
            "x11grab",
            "-video_size",
            "1280x720",
            "-framerate",
            "1",
            "-i",
            f"{DISPLAY}.0",
            "-frames:v",
            "1",
            str(DIAGNOSTICS / "browser.png"),
        ]
    )

    print(
        "Saved browser screenshot for checking playback",
        flush=True,
    )
    return browser


def preview(client):
    try:
        client.set_record_directory(str(DIAGNOSTICS))
    except Exception:
        pass

    client.start_record()
    print("Recording a 20-second OBS preview", flush=True)
    time.sleep(20)

    result = client.stop_record()
    path = getattr(result, "output_path", "")

    if not path or not Path(path).is_file():
        raise RuntimeError("OBS recording output was not found")

    source = Path(path)
    dest = DIAGNOSTICS / source.name

    if source.resolve() != dest.resolve():
        shutil.copy2(source, dest)

    if dest.stat().st_size < 100_000:
        raise RuntimeError(
            "OBS preview recording is unusually small; inspect diagnostics"
        )

    print(
        f"Recorded: {dest.name}; inspect video AND audio",
        flush=True,
    )


def broadcast(client, slot, minutes, server, obs_process, browser_process):
    # Only the selected key is provided to OBS as its RTMP credential.
    # Do not print or log OKRU_KEYS values.
    client.set_stream_service_settings(
        "rtmp_custom",
        {
            "server": server,
            "key": OKRU_KEYS[slot],
        },
    )

    client.start_stream()

    wait_for(
        lambda: client.get_stream_status().output_active,
        "OBS streaming",
        40,
    )

    print(
        f"OBS publishing to OK.ru slot {slot} for {minutes} minute(s)",
        flush=True,
    )

    try:
        for second in range(minutes * 60):
            if (
                obs_process.poll() is not None
                or browser_process.poll() is not None
            ):
                raise RuntimeError("Chrome or OBS exited unexpectedly")

            if second % 10 == 0:
                status = client.get_stream_status()

                if not status.output_active:
                    raise RuntimeError(
                        "OBS stream stopped or RTMP connection failed"
                    )

                print(
                    f"OBS output active: {second}s",
                    flush=True,
                )

            time.sleep(1)

    finally:
        try:
            if client.get_stream_status().output_active:
                client.stop_stream()
        except Exception:
            pass


def main():
    DIAGNOSTICS.mkdir(parents=True, exist_ok=True)

    url, mode, slot, minutes, server = input_config()

    start_display()
    obs_process, client = start_obs()
    configure_obs(client)
    browser_process = launch_chrome(url)

    if mode == "preview":
        preview(client)
    else:
        broadcast(
            client,
            slot,
            minutes,
            server,
            obs_process,
            browser_process,
        )

    print(
        "Finished. Check the diagnostics artifact and OK.ru broadcast dashboard.",
        flush=True,
    )


if __name__ == "__main__":
    main()
