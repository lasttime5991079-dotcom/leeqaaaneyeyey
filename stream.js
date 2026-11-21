
'use strict';

/**
 * Single-Chrome, single-URL OBS broadcaster.
 * Use only with content you are authorized to view and rebroadcast.
 * No DRM bypass, stealth plugin, browser security overrides, or proxy bypass.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const puppeteer = require('puppeteer-core');
const { OBSWebSocket } = require('obs-websocket-js');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (...args) => console.log(new Date().toISOString(), ...args);
const QUALITY = {
  'Original (1080p Max)': [1920, 1080, 6000],
  '1080p': [1920, 1080, 4500],
  '720p': [1280, 720, 3000],
  '480p': [854, 480, 1500],
  '360p': [640, 360, 800]
};
const [width, height, bitrate] = QUALITY[process.env.STREAM_QUALITY] || QUALITY['720p'];
const CAPTURE_WIDTH = 1920;
const CAPTURE_HEIGHT = 1080;
const OBS_PASSWORD = crypto.randomBytes(24).toString('hex');
const MAX_DURATION_MS = 345 * 60 * 1000; // Leave time for cleanup before GitHub's six-hour limit.
const POLL_MS = 2000;
const FREEZE_MS = 14000;
const READY_TIMEOUT_MS = 75000;
const MAX_RECOVERIES = 4;
const OBS_SERVER = 'rtmp://vsu.okcdn.ru/input/';

let browser = null;
let page = null;
let obsProcess = null;
let obsConnected = false;
let streaming = false;
let shuttingDown = false;
const obs = new OBSWebSocket();

function readConfig() {
  const raw = (process.env.TARGET_URL || '').trim();
  if (!raw) throw new Error('TARGET_URL is required (one ordinary webpage URL).');
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http/https URLs are supported.');
  if (/\.m3u8(?:$|\?)/i.test(raw)) throw new Error('Enter a webpage URL, not a direct M3U8 playlist.');
  if ((raw.match(/https?:\/\//gi) || []).length !== 1) throw new Error('Enter exactly one URL.');

  const channel = (process.env.OKRU_STREAM_ID || '').trim();
  if (!channel) throw new Error('OKRU_STREAM_ID is required.');
  let keys;
  try { keys = JSON.parse(process.env.OKRU_STREAM_KEYS_JSON || '{}'); }
  catch { throw new Error('OKRU_STREAM_KEYS_JSON must be valid JSON in a GitHub Actions secret.'); }
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
    throw new Error('OKRU_STREAM_KEYS_JSON must be a JSON object of channel -> stream key.');
  }
  const key = keys[channel];
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error(`No stream key found for channel '${channel}'. Check OKRU_STREAM_KEYS_JSON.`);
  }
  return {
    targetUrl: parsed.href,
    safeHost: parsed.host,
    channel,
    key: key.trim(),
    serverSelection: (process.env.SERVER_SELECTION || 'None').trim(),
    durationMs: parseDuration(process.env.CUSTOM_DURATION || 'None')
  };
}

function parseDuration(raw) {
  if (/^none$/i.test(raw.trim())) return MAX_DURATION_MS;
  const match = raw.trim().match(/^(?:(\d+)\s*h(?:ours?)?\s*)?(?:(\d+)\s*m(?:in(?:utes?)?)?\s*)?$/i);
  if (!match || (!match[1] && !match[2])) throw new Error('CUSTOM_DURATION examples: 1h, 1h 20m, 45m, None.');
  const ms = ((Number(match[1] || 0) * 60) + Number(match[2] || 0)) * 60 * 1000;
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > MAX_DURATION_MS) {
    throw new Error('Duration must be between 1 minute and 5h 45m on GitHub-hosted runners.');
  }
  return ms;
}

function prepareObsConfig() {
  const root = path.join(os.homedir(), '.config', 'obs-studio');
  const profile = path.join(root, 'basic', 'profiles', 'StreamBot');
  const wsDir = path.join(root, 'plugin_config', 'obs-websocket');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'global.ini'),
    '[General]\nLicenseAccepted=true\n[BasicWindow]\nShowAutoConfig=false\nWarned=true\n');
  fs.writeFileSync(path.join(profile, 'basic.ini'), [
    '[General]', 'Name=StreamBot', '[Video]',
    `BaseCX=${CAPTURE_WIDTH}`, `BaseCY=${CAPTURE_HEIGHT}`, `OutputCX=${width}`, `OutputCY=${height}`,
    'FPSCommon=30', '[Audio]', 'SampleRate=48000', 'ChannelSetup=Stereo',
    '[Output]', 'Mode=Simple', '[SimpleOutput]',
    `VBitrate=${bitrate}`, 'ABitrate=160', 'StreamEncoder=x264',
    'UseAdvanced=true', 'Preset=ultrafast', 'x264Settings=keyint=60 tune=zerolatency', ''
  ].join('\n'));
  fs.writeFileSync(path.join(wsDir, 'config.json'), JSON.stringify({
    first_load: false,
    server_enabled: true,
    server_port: 4455,
    alerts_enabled: false,
    auth_required: true,
    server_password: OBS_PASSWORD
  }, null, 2), { mode: 0o600 });
}

async function launchObs() {
  prepareObsConfig();
  obsProcess = spawn('obs', ['--profile', 'StreamBot', '--disable-shutdown-check', '--websocket_ipv4_only'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  obsProcess.on('error', err => log('[OBS] Failed to launch:', err.message));
  obsProcess.on('exit', (code, signal) => log(`[OBS] Process exited: ${code ?? signal}`));
  for (const pipe of [obsProcess.stdout, obsProcess.stderr]) {
    let carried = '';
    pipe.on('data', chunk => {
      carried += chunk.toString();
      const lines = carried.split(/\r?\n/);
      carried = lines.pop();
      for (const line of lines) {
        if (/\b(error|failed|warning)\b/i.test(line)) log('[OBS]', line.slice(0, 280));
      }
    });
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    if (obsProcess.exitCode !== null) break;
    try {
      await obs.connect('ws://127.0.0.1:4455', OBS_PASSWORD, { rpcVersion: 1 });
      obsConnected = true;
      log('[OBS] Authenticated WebSocket connection established.');
      return;
    } catch { await sleep(1000); }
  }
  throw new Error('OBS WebSocket did not start. Check OBS logs and installed OBS version (28+).');
}

async function configureObs(key) {
  const sceneName = 'SingleChromeCapture';
  const scenes = await obs.call('GetSceneList');
  if (!scenes.scenes.some(s => s.sceneName === sceneName)) {
    await obs.call('CreateScene', { sceneName });
  }
  const currentInputs = await obs.call('GetInputList');
  if (!currentInputs.inputs.some(s => s.inputName === 'DesktopVideo')) {
    await obs.call('CreateInput', {
      sceneName,
      inputName: 'DesktopVideo',
      inputKind: 'xshm_input',
      inputSettings: { show_cursor: false },
      sceneItemEnabled: true
    });
  }
  if (!currentInputs.inputs.some(s => s.inputName === 'DesktopAudio')) {
    await obs.call('CreateInput', {
      sceneName,
      inputName: 'DesktopAudio',
      inputKind: 'pulse_output_capture',
      inputSettings: { device_id: 'default' },
      sceneItemEnabled: true
    });
  }
  await obs.call('SetCurrentProgramScene', { sceneName });
  await obs.call('SetStreamServiceSettings', {
    streamServiceType: 'rtmp_custom',
    streamServiceSettings: { server: OBS_SERVER, key }
  });
  log('[OBS] Scene and selected channel configured; no stream has started yet.');
}

async function startBroadcast() {
  if (streaming) return;
  const status = await obs.call('GetStreamStatus');
  if (!status.outputActive) await obs.call('StartStream');
  let active = false;
  for (let i = 0; i < 20; i++) {
    const verify = await obs.call('GetStreamStatus');
    if (verify.outputActive) { active = true; break; }
    await sleep(1000);
  }
  if (!active) throw new Error('OBS did not confirm an active broadcast within 20 seconds.');
  streaming = true;
  log('[OBS] Broadcasting verified playback.');
}

async function stopBroadcast() {
  if (!obsConnected) return;
  try {
    const status = await obs.call('GetStreamStatus');
    if (status.outputActive) await obs.call('StopStream');
  } catch (err) { log('[OBS] Stream stop warning:', err.message); }
  streaming = false;
}

async function launchSingleChrome() {
  const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';
  if (!fs.existsSync(chrome)) throw new Error(`Google Chrome executable not found: ${chrome}`);
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: false,
    defaultViewport: null,
    args: [
      '--no-sandbox', // Required only in the isolated GitHub-hosted runner.
      '--disable-dev-shm-usage',
      `--window-size=${CAPTURE_WIDTH},${CAPTURE_HEIGHT}`,
      '--window-position=0,0',
      '--kiosk',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });
  const pages = await browser.pages();
  page = pages[0] || await browser.newPage();
  for (const extra of pages.slice(1)) await extra.close().catch(() => {});
  browser.on('targetcreated', async target => {
    // No ad-popup window or backup page. Remain inside one browser + one intended tab.
    if (target.type() === 'page') {
      try { const p = await target.page(); if (p && p !== page) await p.close(); } catch {}
    }
  });
  page.setDefaultNavigationTimeout(45000);
  page.on('pageerror', err => log('[PAGE] JavaScript error:', err.message.slice(0, 220)));
  page.on('requestfailed', req => {
    if (req.isNavigationRequest()) log('[NETWORK] Navigation failed:', req.failure()?.errorText || 'Unknown error');
  });
  await page.evaluateOnNewDocument(() => {
    window.__streamBotEvents = { encrypted: false, waitingForKey: false };
    document.addEventListener('encrypted', () => { window.__streamBotEvents.encrypted = true; }, true);
    document.addEventListener('waitingforkey', () => { window.__streamBotEvents.waitingForKey = true; }, true);
  });
  log('[CHROME] Launched one Chrome with one monitored tab.');
}

async function tryPlayFromPage() {
  if (!page || page.isClosed()) return;
  const selectors = [
    'button[aria-label="Play"]', '.jw-icon-display', '.vjs-big-play-button',
    '[data-plyr="play"]', '.plyr__control--overlaid'
  ];
  for (const frame of page.frames()) {
    try {
      const alreadyPlaying = await frame.evaluate(() =>
        [...document.querySelectorAll('video')].some(v =>
          v.clientWidth >= 100 && v.clientHeight >= 80 && !v.paused && !v.ended));
      if (alreadyPlaying) continue; // Never toggle a live player's Play button.
      for (const selector of selectors) {
        const button = await frame.$(selector);
        if (button) {
          const visible = await button.isVisible().catch(() => false);
          if (visible) { await button.click({ delay: 50 }).catch(() => {}); break; }
        }
      }
      await frame.evaluate(() => {
        for (const video of document.querySelectorAll('video')) {
          if (video.clientWidth >= 100 && video.clientHeight >= 80 && video.paused) {
            video.muted = false;
            video.volume = 1.0;
            video.play().catch(() => {}); // Normal browser policy applies.
          }
        }
      });
    } catch {}
  }
}

async function clickServerIfRequested(serverName) {
  if (!serverName || /^none$/i.test(serverName)) return;
  for (let attempt = 0; attempt < 8; attempt++) {
    for (const frame of page.frames()) {
      try {
        const clicked = await frame.evaluate(name => {
          const needle = name.trim().toLowerCase();
          const elements = document.querySelectorAll('button, [role="button"], a');
          for (const element of elements) {
            if (element.getBoundingClientRect().width === 0) continue;
            if ((element.textContent || '').trim().toLowerCase() === needle) {
              element.click();
              return true;
            }
          }
          return false;
        }, serverName);
        if (clicked) { log('[PLAYER] Selected server:', serverName); await sleep(3000); return; }
      } catch {}
    }
    await sleep(1200);
  }
  log('[PLAYER] Requested server button not found:', serverName);
}

async function samplePlayback() {
  if (!browser?.isConnected() || !page || page.isClosed()) return { type: 'BROWSER_CLOSED' };
  let best = null;
  let encrypted = false;
  for (const frame of page.frames()) {
    try {
      if (frame.isDetached()) continue;
      const result = await Promise.race([
        frame.evaluate(() => {
          const text = (document.body?.innerText || '').slice(0, 20000);
          if (/there was a problem providing access to protected content|playback error[^\n]{0,100}protected content|drm license (?:denied|error|failed)/i.test(text)) {
            return { type: 'PROTECTED_CONTENT' };
          }
          const events = window.__streamBotEvents || {};
          const videos = [...document.querySelectorAll('video')]
            .filter(v => v.clientWidth > 80 && v.clientHeight > 60)
            .sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
          if (!videos.length) return { type: 'NO_VIDEO', encrypted: events.encrypted || events.waitingForKey };
          const v = videos[0];
          const quality = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
          return {
            type: 'VIDEO',
            time: Number(v.currentTime || 0),
            frames: quality ? Number(quality.totalVideoFrames || 0) : null,
            paused: v.paused,
            ended: v.ended,
            ready: v.readyState,
            videoWidth: v.videoWidth,
            videoHeight: v.videoHeight,
            mediaError: v.error ? { code: v.error.code, message: v.error.message || '' } : null,
            encrypted: !!(events.encrypted || events.waitingForKey || v.mediaKeys)
          };
        }),
        sleep(3500).then(() => ({ type: 'FRAME_TIMEOUT' }))
      ]);
      if (result.type === 'PROTECTED_CONTENT') return result;
      if (result.encrypted) encrypted = true;
      if (result.type === 'VIDEO') {
        if (!best || result.videoWidth * result.videoHeight > best.videoWidth * best.videoHeight) best = result;
      }
    } catch {}
  }
  return best || { type: 'NO_VIDEO', encrypted };
}

function progressed(previous, current) {
  if (!previous || current.type !== 'VIDEO' || current.mediaError || current.ended || current.paused) return false;
  if (current.ready < 2 || current.videoWidth < 2 || current.videoHeight < 2) return false;
  const timeMoved = current.time > previous.time + 0.05;
  if (current.frames !== null && previous.frames !== null && (current.frames > 0 || previous.frames > 0)) {
    return current.frames > previous.frames;
  }
  return timeMoved;
}

async function navigateAndWaitForVideo(targetUrl, serverSelection, deadline) {
  log('[PLAYER] Loading authorized webpage (no playlist extraction).');
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await clickServerIfRequested(serverSelection);
  const cutoff = Math.min(Date.now() + READY_TIMEOUT_MS, deadline);
  let previous = null;
  let consecutive = 0;
  let lastPlayAttempt = 0;
  let sawEncryption = false;
  while (Date.now() < cutoff) {
    if (Date.now() - lastPlayAttempt > 9000) {
      await tryPlayFromPage();
      lastPlayAttempt = Date.now();
    }
    const current = await samplePlayback();
    if (current.type === 'PROTECTED_CONTENT') {
      throw new Error('PROTECTED_CONTENT: Website reports a protected-content access failure. Check DRM, entitlement, and browser compatibility; no bypass attempted.');
    }
    if (current.type === 'BROWSER_CLOSED') throw new Error('Chrome disconnected.');
    if (current.encrypted) sawEncryption = true;
    if (current.type === 'VIDEO' && current.mediaError) {
      log(`[PLAYER] Media error ${current.mediaError.code}: ${current.mediaError.message.slice(0, 150)}`);
    }
    if (progressed(previous, current)) consecutive++;
    else consecutive = 0;
    if (consecutive >= 2) {
      log(`[PLAYER] Confirmed moving video (${current.videoWidth}x${current.videoHeight}, decoded frames progressing).`);
      return current;
    }
    previous = current.type === 'VIDEO' ? current : null;
    await sleep(POLL_MS);
  }
  const note = sawEncryption ? ' Encrypted-media/DRM activity was detected; check authorized license access.' : '';
  throw new Error('VIDEO_NOT_READY: No verified advancing video within startup window.' + note);
}

async function monitorStream(targetUrl, serverSelection, deadline) {
  let recoveries = 0;
  let previous = null;
  let lastProgress = Date.now();
  let lastObsCheck = 0;
  let lastHeartbeat = 0;
  let continuousHealthyStart = Date.now();

  while (Date.now() < deadline) {
    const current = await samplePlayback();
    if (current.type === 'PROTECTED_CONTENT') {
      await stopBroadcast();
      throw new Error('PROTECTED_CONTENT: Access to protected media failed. Broadcast stopped; automatic bypass/retry disabled.');
    }
    if (current.type === 'BROWSER_CLOSED') {
      await stopBroadcast();
      throw new Error('Chrome disconnected; no second browser will be launched.');
    }
    if (progressed(previous, current)) lastProgress = Date.now();
    previous = current.type === 'VIDEO' ? current : null;

    if (Date.now() - lastHeartbeat >= 30000) {
      log(`[HEARTBEAT] ${current.type}; advancing=${Date.now() - lastProgress < FREEZE_MS}; ` +
          `time=${current.type === 'VIDEO' ? current.time.toFixed(1) : 'n/a'}; recoveries=${recoveries}`);
      lastHeartbeat = Date.now();
    }
    if (Date.now() - lastObsCheck >= 30000) {
      const state = await obs.call('GetStreamStatus');
      if (!state.outputActive && Date.now() - lastProgress < FREEZE_MS) {
        log('[OBS] Output disconnected; restarting only because video is healthy.');
        streaming = false;
        await startBroadcast();
      }
      lastObsCheck = Date.now();
    }
    if (Date.now() - continuousHealthyStart > 5 * 60 * 1000) {
      recoveries = 0; // Reset fault counter after a sustained healthy period.
      continuousHealthyStart = Date.now();
    }
    if (Date.now() - lastProgress >= FREEZE_MS) {
      recoveries++;
      continuousHealthyStart = Date.now();
      log(`[RECOVERY] Playback stalled for ${FREEZE_MS / 1000}s. Same URL, recovery ${recoveries}/${MAX_RECOVERIES}.`);
      await stopBroadcast(); // Never knowingly broadcast a frozen image.
      if (recoveries > MAX_RECOVERIES) throw new Error('Maximum same-URL recovery attempts exceeded.');
      await sleep(Math.min(3000 * recoveries, 12000));
      const verified = await navigateAndWaitForVideo(targetUrl, serverSelection, deadline);
      await startBroadcast();
      previous = verified;
      lastProgress = Date.now();
      lastObsCheck = Date.now();
    }
    await sleep(POLL_MS);
  }
  log('[DONE] Requested duration completed.');
}

async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopBroadcast();
  if (browser) { try { await browser.close(); } catch {} browser = null; }
  if (obsConnected) { try { await obs.disconnect(); } catch {} obsConnected = false; }
  if (obsProcess && obsProcess.exitCode === null) {
    obsProcess.kill('SIGTERM');
    const child = obsProcess;
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
  }
}

async function main() {
  const cfg = readConfig();
  const deadline = Date.now() + cfg.durationMs;
  log(`[CONFIG] Channel=${cfg.channel}; URL host=${cfg.safeHost}; ` +
      `Quality=${width}x${height}@30fps; duration=${Math.round(cfg.durationMs / 60000)}m; Chrome=1; URL=1`);
  await launchObs();
  await configureObs(cfg.key);
  await launchSingleChrome();
  await navigateAndWaitForVideo(cfg.targetUrl, cfg.serverSelection, deadline);
  await startBroadcast();
  await monitorStream(cfg.targetUrl, cfg.serverSelection, deadline);
}

process.once('SIGINT', () => { cleanup().finally(() => process.exit(130)); });
process.once('SIGTERM', () => { cleanup().finally(() => process.exit(143)); });
process.on('unhandledRejection', err => { log('[FATAL] Unhandled rejection:', err); cleanup().finally(() => process.exit(1)); });
main().then(() => cleanup()).catch(async err => {
  log('[FATAL]', err.message);
  await cleanup();
  process.exitCode = 1;
});
