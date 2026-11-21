'use strict';

const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const puppeteer = require('puppeteer-core');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { OBSWebSocket } = require('obs-websocket-js/json');

const qualities = {
  'Original (1080p Max)': [1920, 1080, 6000],
  '1080p': [1920, 1080, 4500],
  '720p': [1280, 720, 3000],
  '480p': [854, 480, 1500],
  '360p': [640, 360, 800],
};
const timing = { navigation: 20_000, startup: 35_000, poll: 1_000, cooldown: 15_000 };
const CHANNEL_VARIANTS = { 1: 11, 2: 2, 3: 6, 4: 5, 5: 7, s1: 10, s2: 10 };
const STREAM_KEYS = Object.fromEntries([
  ...Array.from({ length: 8 }, (_, index) => String(index + 1)),
  ...Object.entries(CHANNEL_VARIANTS).flatMap(([id, count]) =>
    Array.from({ length: count }, (_, index) => `${id}.${index + 1}`)),
].map((id) => [id, '']));
const ORIGINAL_INGEST = 'rtmp://vsu.okcdn.ru/input/';
const PLAY_BUTTON = '.jw-icon-display[aria-label="Play"], button[data-plyr="play"], .vjs-big-play-button, .fp-play';
const mediaErrors = {
  2: 'video network error',
  3: 'video decode error',
  4: 'unsupported video source or codec',
};

class BotError extends Error {}

function readSettings(env) {
  const targets = new Map();
  for (const entry of (env.TARGET_URLS ?? '').split(',')) {
    const item = entry.trim();
    if (!item) continue;
    const extended = item.startsWith('!');
    const address = extended ? item.slice(1).trim() : item;
    const number = targets.size + 1;
    let url;
    try {
      const explicitScheme = /^[a-z][a-z\d+.-]*:/i.test(address) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(address);
      url = new URL(explicitScheme ? address : `https://${address}`);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch {
      throw new BotError(`Source ${number} requires a valid HTTP(S) URL without embedded credentials.`);
    }
    if (!targets.has(url.href)) {
      targets.set(url.href, { number, url: url.href, stallMs: extended ? 20_000 : 8_000 });
    }
  }
  if (!targets.size) throw new BotError('Provide at least one source URL in TARGET_URLS.');

  const duration = (env.CUSTOM_DURATION || 'None').trim();
  const parts = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/i.exec(duration);
  const maxMinutes = Number(env.STREAM_MAX_MINUTES || 345);
  const minutes = /^none$/i.test(duration) ? maxMinutes : parts && Number(parts[1] ?? 0) * 60 + Number(parts[2] ?? 0);
  if (!Number.isInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 345 ||
      !Number.isInteger(minutes) || minutes < 1 || minutes > maxMinutes) {
    throw new BotError('Choose a duration up to 5h 45m, such as 4h 30m, or use None.');
  }

  const quality = env.STREAM_QUALITY || 'Original (1080p Max)';
  if (!Object.hasOwn(qualities, quality)) throw new BotError('Select a supported STREAM_QUALITY.');
  const [width, height, bitrate] = qualities[quality];
  const serverSelection = (env.SERVER_SELECTION || 'None').trim();
  const channel = (env.OKRU_STREAM_ID || '1').trim().toLowerCase();
  if (!Object.hasOwn(STREAM_KEYS, channel)) throw new BotError('Unknown OK.ru channel ID.');
  const ingestUrl = env.STREAM_INGEST_URL?.trim() || ORIGINAL_INGEST;
  const streamKey = env.STREAM_KEY?.trim() || STREAM_KEYS[channel];
  if (!/^rtmps?:\/\/[^\s]+$/i.test(ingestUrl) || !streamKey) {
    throw new BotError(`Configure OKRU_STREAM_KEY_${channel.toUpperCase().replaceAll('.', '_')} and verify the RTMP server address.`);
  }
  if (env.PROXY_ENGINE && env.PROXY_ENGINE !== 'None (Direct GitHub IP)') {
    throw new BotError('This workflow is configured for direct runner networking.');
  }
  return {
    sources: [...targets.values()], width, height, bitrate, ingestUrl, streamKey,
    durationMs: minutes * 60_000,
    videoSelector: (env.VIDEO_SELECTOR || '').trim() || 'video',
    serverSelection: /^none$/i.test(serverSelection) ? '' : serverSelection,
  };
}

async function selectServer(page, label, signal, timings) {
  const deadline = performance.now() + Math.min(8_000, timings.startup / 2);
  while (performance.now() < deadline) {
    for (const frame of page.frames()) {
      signal.throwIfAborted();
      const clicked = await frame.evaluate((name) => {
        const buttons = [...document.querySelectorAll('button, [role="button"]')]
          .filter((button) => button.getClientRects().length && !button.matches(':disabled, [aria-disabled="true"]'));
        const text = (button) => (button.innerText ?? button.textContent ?? '').trim();
        const control = buttons.find((button) => text(button) === name) ||
          buttons.find((button) => text(button).includes(name));
        control?.click();
        return Boolean(control);
      }, label).catch(() => false);
      if (clicked) return;
    }
    await delay(timings.poll, undefined, { signal });
  }
  console.warn('Requested server button was unavailable. Checking the page’s default player.');
}

async function installPlaybackDiagnostics(page) {
  await page.evaluateOnNewDocument(() => {
    const events = new WeakMap();
    window.streamMediaEvents = events;
    for (const type of ['encrypted', 'waitingforkey', 'playing', 'emptied']) {
      document.addEventListener(type, ({ target }) => {
        if (!(target instanceof HTMLVideoElement)) return;
        const state = events.get(target) || {};
        if (type === 'encrypted') state.encrypted = true;
        if (type === 'waitingforkey') state.waitingForKey = true;
        if (type === 'playing') state.waitingForKey = false;
        if (type === 'emptied') events.delete(target);
        else events.set(target, state);
      }, true);
    }
  });
  let fault;
  const relevantRequest = (request) => ['document', 'media'].includes(request.resourceType()) ||
    /\.(?:m3u8|mpd|m4s|ts)(?:[?#]|$)/i.test(request.url());
  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText;
    if (relevantRequest(request) && /^net::ERR_[A-Z0-9_]+$/.test(reason || '') && reason !== 'net::ERR_ABORTED') {
      fault = reason;
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && relevantRequest(response.request())) fault = `HTTP ${response.status()}`;
  });
  return { lastFault: () => fault, reset: () => { fault = undefined; } };
}

async function inspectPlayer(page, selector) {
  const snapshots = await Promise.all(page.frames().map(async (frame) => {
    const observation = await frame.evaluate((css) => {
      const monitor = globalThis.streamVideoMonitor ??= { ids: new WeakMap(), play: new WeakMap(), nextId: 0 };
      const candidates = [...document.querySelectorAll(css)].filter((el) => el instanceof HTMLVideoElement);
      let player;
      for (const video of candidates) {
        const rect = video.getBoundingClientRect();
        const style = getComputedStyle(video);
        if (style.visibility !== 'visible' || Number(style.opacity) === 0 ||
            rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) continue;
        const area = rect.width * rect.height;
        if (!area || area <= (player?.area ?? 0)) continue;
        if (!monitor.ids.has(video)) monitor.ids.set(video, ++monitor.nextId);
        const quality = video.getVideoPlaybackQuality?.();
        const frames = quality ? quality.totalVideoFrames - quality.droppedVideoFrames : video.webkitDecodedFrameCount;
        const media = window.streamMediaEvents?.get(video);
        player = {
          id: `${performance.timeOrigin}:${monitor.ids.get(video)}`,
          area,
          time: video.currentTime,
          frames: Number.isFinite(frames) ? frames : null,
          paused: video.paused,
          ended: video.ended,
          advancing: Boolean(video.videoWidth) && !video.paused && !video.ended && !video.seeking && video.readyState >= 2,
          ready: video.readyState >= 1,
          error: video.error?.code ?? 0,
          playError: monitor.play.get(video)?.error,
          encrypted: Boolean(media?.encrypted || video.mediaKeys),
          waitingForKey: Boolean(media?.waitingForKey),
        };
      }
      const alerts = [...document.querySelectorAll('.jw-error-msg, [role="alert"]')]
        .filter((el) => el.getClientRects().length && getComputedStyle(el).visibility === 'visible');
      const playerText = alerts.map((el) => el.innerText).join(' ');
      const text = (playerText || document.body?.innerText || '').replace(/\s+/g, ' ');
      const code = text.match(/\berror\s+code\s*:?\s*(\d{6,8})\b/i)?.[1];
      let notice;
      if (/there was a problem providing access to protected content/i.test(text)) {
        notice = { reason: 'player reported a protected-content access error', code, blocked: true };
      } else if (/\b(?:this )?domain is blocked\b|\berror:\s*forbidden\b|\baccess denied\b/i.test(text)) {
        notice = { reason: 'player reported an access restriction', code, blocked: true };
      } else if (/problem with your internet connection|live stream is either down or has ended|error loading media|\bstream unavailable\b|the video cannot be played in this browser/i.test(text) ||
          (playerText && /\bplayback error\b/i.test(text))) {
        notice = { reason: 'player reported a playback or connection error', code };
      }
      const playingVideos = [...document.querySelectorAll('video')]
        .filter((video) => !video.paused && !video.ended).length;
      return { player, notice, playingVideos };
    }, selector).catch(() => null);
    return { frame, ...observation };
  }));
  if (!page.browser().connected || page.isClosed()) throw new BotError('Chrome control was lost.');
  const best = snapshots.reduce((a, b) => (b.player?.area ?? 0) > (a?.player.area ?? 0) ? b : a, null);
  const mainNotice = snapshots.find((snapshot) => snapshot.frame === page.mainFrame())?.notice;
  const notice = best?.notice || mainNotice || (!best && snapshots.find((snapshot) => snapshot.notice)?.notice);
  return { notice, best, playing: snapshots.filter((snapshot) => snapshot.playingVideos) };
}

async function pauseExtraVideos(best, playing) {
  if (!best || playing.reduce((count, snapshot) => count + snapshot.playingVideos, 0) <= Number(!best.player.paused && !best.player.ended)) return;
  await Promise.all(playing.map(({ frame }) => frame.evaluate((keepId) => {
    for (const video of document.querySelectorAll('video')) {
      const id = window.streamVideoMonitor?.ids.get(video);
      if (!video.paused && `${performance.timeOrigin}:${id}` !== keepId) video.pause();
    }
  }, frame === best.frame ? best.player.id : null).catch(() => {})));
}

function progressed(previous, next) {
  return previous && next && previous.frame === next.frame && previous.player.id === next.player.id &&
    next.player.advancing && (next.player.frames === null || next.player.frames > previous.player.frames) &&
    next.player.time - previous.player.time >= 0.10;
}

async function controlPlayer({ frame, player }, selector, action) {
  await frame.evaluate((css, id, control) => {
    for (const el of document.querySelectorAll(css)) {
      const identity = globalThis.streamVideoMonitor?.ids.get(el);
      if (`${performance.timeOrigin}:${identity}` === id) {
        if (control === 'play') {
          const attempts = globalThis.streamVideoMonitor.play;
          const previous = attempts.get(el);
          if (previous?.inFlight || (previous && Date.now() - previous.at < 3_000)) break;
          const attempt = { at: Date.now(), inFlight: true };
          attempts.set(el, attempt);
          void el.play().catch((error) => {
            if (['NotAllowedError', 'NotSupportedError'].includes(error.name)) attempt.error = error.name;
          }).finally(() => { attempt.inFlight = false; });
        }
        if (control === 'present') {
          el.muted = false;
          if (el.volume === 0) el.volume = 1;
          if (document.fullscreenEnabled && !document.fullscreenElement) {
            void el.requestFullscreen().catch(() => {});
          }
        }
        break;
      }
    }
  }, selector, player.id, action).catch(() => {});
}

async function pressPlay(page) {
  for (const frame of page.frames()) {
    const button = await frame.$(PLAY_BUTTON).catch(() => null);
    if (!button) continue;
    try {
      if (await button.isVisible()) {
        await button.click();
        return;
      }
    } catch {
      // The player can replace the button as playback starts.
    } finally {
      await button.dispose().catch(() => {});
    }
  }
}

async function watchSource(page, source, config, showLive, signal, timings, network) {
  let response;
  network.reset();
  try {
    response = await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: timings.navigation });
  } catch {
    signal.throwIfAborted();
    if (!page.browser().connected || page.isClosed()) throw new BotError('Chrome control was lost.');
    const fault = network.lastFault();
    return { reason: fault ? `navigation failed (${fault})` : 'navigation failed or timed out' };
  }

  const status = response?.status();
  if ([401, 403, 451].includes(status)) return { reason: `page returned HTTP ${status}`, blocked: true };
  if (status >= 400) return { reason: `page returned HTTP ${status}` };

  const startupDeadline = performance.now() + timings.startup;
  let choosingServer = Boolean(config.serverSelection);
  let previous;
  let presented;
  let live = false;
  let goodSamples = 0;
  let nextPlayControl = 0;
  let previousFailure;
  let playedSince;
  let lastAdvance = performance.now();
  const outcome = (reason, blocked = false) => ({ live, reason, blocked, healthyMs: live ? lastAdvance - playedSince : 0 });
  for (;;) {
    signal.throwIfAborted();
    const { best, notice, playing } = await inspectPlayer(page, config.videoSelector);
    signal.throwIfAborted();
    if (notice?.blocked) {
      const detail = notice.code ? ` (player code ${notice.code})` : '';
      return outcome(`${notice.reason}${detail}`, true);
    }
    if (choosingServer) {
      await selectServer(page, config.serverSelection, signal, timings);
      choosingServer = false;
      continue;
    }

    await pauseExtraVideos(best, playing);
    const now = performance.now();
    const player = best?.player;
    if (progressed(previous, best)) {
      lastAdvance = now;
      goodSamples++;
      previousFailure = undefined;
    } else {
      goodSamples = 0;
      const reported = notice && `${notice.reason}${notice.code ? ` (player code ${notice.code})` : ''}`;
      const failure = player?.ended ? 'video ended' : mediaErrors[player?.error] || reported;
      if (failure && failure === previousFailure && !player?.waitingForKey) return outcome(failure);
      previousFailure = failure;
      if (player?.paused && player.ready && !player.ended && !player.error) {
        await controlPlayer(best, config.videoSelector, 'play');
      }
      if (!live && !player?.advancing && !player?.waitingForKey && now >= nextPlayControl) {
        nextPlayControl = now + 3_000;
        await pressPlay(page);
      }
    }
    previous = best;

    if (goodSamples >= 2 && (presented?.frame !== best?.frame || presented?.player.id !== player?.id)) {
      await controlPlayer(best, config.videoSelector, 'present');
      signal.throwIfAborted();
      presented = best;
    }
    if (!live && goodSamples >= 2) {
      await showLive(true);
      console.log(`[Source ${source.number}] Playing. OBS is on the live scene.`);
      playedSince = now;
      live = true;
    }
    if ((!live && now >= startupDeadline) || (live && now - lastAdvance >= source.stallMs)) {
      if (player?.waitingForKey) return outcome('protected playback did not resume while waiting for a key', true);
      const detail = player?.playError === 'NotAllowedError' ? 'browser denied autoplay' :
        player?.playError === 'NotSupportedError' ? 'unsupported video source or codec' :
        player ? 'video did not advance' : 'no matching visible video';
      const fault = network.lastFault();
      const extra = [player?.encrypted && 'encrypted media observed', fault && `network: ${fault}`].filter(Boolean);
      const message = live ? 'video stalled' : `startup timed out (${detail})`;
      return outcome(extra.length ? `${message}; ${extra.join(', ')}` : message);
    }
    await delay(timings.poll, undefined, { signal });
  }
}

async function runSources({ page, config, showLive, showStatus = async () => {}, signal, timings = timing }) {
  const skipped = new Set();
  let cooldown = timings.cooldown;
  let failedPasses = 0;
  const valid = await page.evaluate((css) => {
    try {
      document.querySelector(css);
      return true;
    } catch {
      return false;
    }
  }, config.videoSelector);
  if (!valid) throw new BotError('VIDEO_SELECTOR must be a valid CSS selector.');
  const network = await installPlaybackDiagnostics(page);

  for (;;) {
    for (const source of config.sources) {
      if (skipped.has(source.number)) continue;
      for (let attempt = 1; attempt <= 2; attempt++) {
        signal.throwIfAborted();
        await showStatus(attempt === 1 ? `Loading source ${source.number}` : `Recovering source ${source.number}`);
        console.log(`[Source ${source.number}] Checking playback (attempt ${attempt}/2).`);
        const outcome = await watchSource(page, source, config, showLive, signal, timings, network);
        if (outcome.live) {
          await showStatus(`Recovering source ${source.number}`);
          await showLive(false);
        }
        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: timings.navigation })
          .catch(() => { throw new BotError('The failed page could not be cleared.'); });
        console.warn(`[Source ${source.number}] ${outcome.reason}${outcome.blocked ? '. Skipping for this run' : ''}.`);
        if (outcome.healthyMs >= 60_000) {
          failedPasses = 0;
          cooldown = timings.cooldown;
        }
        if (outcome.blocked) {
          skipped.add(source.number);
          break;
        }
        if (attempt === 1) await delay(timings.poll, undefined, { signal });
      }
    }

    if (skipped.size === config.sources.length) throw new BotError('All configured sources reported access errors.');
    if (++failedPasses >= 3) throw new BotError('Playback could not be sustained after three source-list passes.');
    await showStatus('Waiting to retry playback');
    console.log(`End of source list. Retrying in ${Math.round(cooldown / 1000)} seconds.`);
    await delay(cooldown, undefined, { signal });
    cooldown = Math.min(cooldown * 2, 120_000);
  }
}

async function main() {
  const config = readSettings(process.env);
  delete process.env.STREAM_KEY;
  delete process.env.STREAM_INGEST_URL;
  delete process.env.TARGET_URLS;
  if (!process.env.DISPLAY) throw new BotError('An X11 display is required. Run inside Xvfb.');
  const stop = new AbortController();
  const requestStop = () => stop.abort();
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);
  const timer = config.durationMs ? setTimeout(requestStop, config.durationMs) : undefined;
  let obs;
  let browser;
  let infrastructureError;
  const fail = (error) => {
    if (!stop.signal.aborted) infrastructureError = error;
    stop.abort();
  };

  try {
    obs = await createObs({ ...config, signal: stop.signal });
    obs.failure.catch(fail);
    stop.signal.throwIfAborted();
    browser = await puppeteer.launch({
      executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
      headless: false,
      defaultViewport: null,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      ignoreDefaultArgs: ['--disable-popup-blocking', '--disable-component-update'],
      protocolTimeout: 8_000,
      args: ['--kiosk', '--window-position=0,0', '--window-size=1920,1080',
        '--autoplay-policy=no-user-gesture-required', '--no-first-run'],
    }).catch(() => { throw new BotError('Chrome did not start. Check CHROME_PATH and the runner’s Chrome sandbox.'); });
    browser.once('disconnected', () => fail(new BotError('Chrome disconnected.')));
    stop.signal.throwIfAborted();
    const [page, ...extraPages] = await browser.pages();
    if (!page) throw new BotError('Chrome started without a player tab.');
    await Promise.all(extraPages.map((extra) => extra.close()));
    page.on('popup', (popup) => { void popup.close().catch(() => {}); });
    page.on('dialog', (dialog) => { void dialog.dismiss().catch(() => {}); });
    page.once('error', () => fail(new BotError('The Chrome player tab crashed.')));
    await page.bringToFront();
    await runSources({ page, config, showLive: obs.showLive, showStatus: obs.showStatus, signal: stop.signal });
  } catch (error) {
    if (infrastructureError) throw infrastructureError;
    if (!stop.signal.aborted) throw error;
  } finally {
    stop.abort();
    clearTimeout(timer);
    try {
      await obs?.close();
    } finally {
      await browser?.close().catch(() => {});
    }
    process.off('SIGINT', requestStop);
    process.off('SIGTERM', requestStop);
  }
}

const COLLECTION = 'Stream Bot';
const CONFIG_NAME = 'StreamBot';
const WAITING = 'Waiting';
const LIVE = 'Live';
const WAITING_TEXT = 'Stream Status';
const BASE_WIDTH = 1920;
const BASE_HEIGHT = 1080;

class ObsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ObsError';
  }
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function within(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function writeConfig(root, { width, height, bitrate, ingestUrl, streamKey }, port, password) {
  const obsRoot = join(root, 'obs-studio');
  const profileDir = join(obsRoot, 'basic', 'profiles', CONFIG_NAME);
  const sceneDir = join(obsRoot, 'basic', 'scenes');
  const websocketDir = join(obsRoot, 'plugin_config', 'obs-websocket');
  await Promise.all([profileDir, sceneDir, websocketDir].map((directory) => mkdir(directory, { recursive: true })));

  const frontendIni = `[General]\nLanguage=en-US\nFirstRun=true\n` +
    `[Basic]\nProfile=${COLLECTION}\nProfileDir=${CONFIG_NAME}\nSceneCollection=${COLLECTION}\nSceneCollectionFile=${CONFIG_NAME}\n` +
    '[BasicWindow]\nPreviewEnabled=false\n';
  const websocketIni = '[OBSWebSocket]\nFirstLoad=false\nServerEnabled=true\nAuthRequired=true\n' +
    `AlertsEnabled=false\nServerPort=${port}\nServerPassword=${password}\n`;
  const websocketConfig = {
    first_load: false, server_enabled: true, auth_required: true,
    alerts_enabled: false, server_port: port, server_password: password,
  };
  const profileIni = `[General]\nName=${COLLECTION}\n[Output]\nMode=Simple\n` +
    `[Video]\nBaseCX=${BASE_WIDTH}\nBaseCY=${BASE_HEIGHT}\nOutputCX=${width}\nOutputCY=${height}\nFPSCommon=30\n` +
    `[SimpleOutput]\nVBitrate=${bitrate}\nABitrate=160\nStreamEncoder=x264\nPreset=veryfast\nUseAdvanced=true\nx264Settings=keyint=60\n`;
  const service = { type: 'rtmp_custom', settings: { server: ingestUrl, key: streamKey } };
  const collection = {
    name: COLLECTION,
    current_scene: WAITING,
    current_program_scene: WAITING,
    scene_order: [{ name: WAITING }],
    sources: [{ name: WAITING, id: 'scene', versioned_id: 'scene', settings: { items: [] } }],
    current_transition: 'Cut',
  };
  const privateFile = { mode: 0o600 };
  await Promise.all([
    writeFile(join(obsRoot, 'global.ini'), frontendIni + websocketIni, privateFile),
    writeFile(join(obsRoot, 'user.ini'), frontendIni, privateFile),
    writeFile(join(websocketDir, 'config.json'), JSON.stringify(websocketConfig), privateFile),
    writeFile(join(profileDir, 'basic.ini'), profileIni, privateFile),
    writeFile(join(profileDir, 'service.json'), JSON.stringify(service), privateFile),
    writeFile(join(sceneDir, `${CONFIG_NAME}.json`), JSON.stringify(collection), privateFile),
  ]);
}

async function createObs({ width, height, bitrate, ingestUrl, streamKey, signal }) {
  if (!process.env.DISPLAY || !process.env.PULSE_SINK) {
    throw new ObsError('OBS requires a dedicated X11 DISPLAY and PulseAudio PULSE_SINK.');
  }

  signal?.throwIfAborted();
  const root = await mkdtemp(join(tmpdir(), 'stream-obs-'));
  const obs = new OBSWebSocket();
  const lifetime = new AbortController();
  const startupSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  let child;
  let childClosed;
  let startup;
  let closePromise;
  let streamRequested = false;
  let outputStartup;
  let readyOutput;
  let sceneChange = Promise.resolve();
  let canShowStatus = false;
  let rejectFailure;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  failure.catch(() => {});

  function fail(message) {
    if (!closePromise) rejectFailure(new ObsError(message));
  }

  async function call(name, data) {
    try {
      return await within(obs.call(name, data), 5000, 'OBS request timed out.');
    } catch (error) {
      const code = Number.isInteger(error.code) ? ` (code ${error.code})` : '';
      throw new ObsError(`OBS ${name} failed${code}.`);
    }
  }

  async function cleanup() {
    lifetime.abort();
    if (obs.identified && streamRequested) await call('StopStream').catch(() => {});
    await within(obs.disconnect(), 2000, 'OBS disconnect timed out.').catch(() => {});
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      try {
        await within(childClosed, 5000, 'OBS shutdown timed out.');
      } catch {
        child.kill('SIGKILL');
        await childClosed;
      }
    }
    await startup?.catch(() => {});
    await outputStartup?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }

  function close() {
    closePromise ??= Promise.resolve().then(cleanup);
    return closePromise;
  }

  async function startOutput() {
    startupSignal.throwIfAborted();
    streamRequested = true;
    try {
      await call('StartStream');
    } catch (error) {
      throw new ObsError(`${error.message} Check the ingest address and selected channel key.`);
    }

    const deadline = performance.now() + 25000;
    do {
      startupSignal.throwIfAborted();
      const status = await call('GetStreamStatus');
      if (status.outputActive && !status.outputReconnecting && status.outputBytes > 0) {
        console.log('[OBS] Broadcast started and ingest bytes confirmed.');
        return;
      }
      await delay(500, undefined, { signal: startupSignal });
    } while (performance.now() < deadline);
    throw new ObsError('OBS did not confirm bytes sent to the ingest destination. Check the ingest address and selected channel key.');
  }

  function showLive(live) {
    const change = sceneChange.then(async () => {
      startupSignal.throwIfAborted();
      await call('SetCurrentProgramScene', { sceneName: live ? LIVE : WAITING });
      if (live) {
        if (!outputStartup) {
          outputStartup = startOutput();
          readyOutput = Promise.race([outputStartup, failure]);
        }
        await readyOutput;
      }
    });
    sceneChange = change.catch(() => {});
    return change;
  }

  async function showStatus(message) {
    if (!canShowStatus) return;
    startupSignal.throwIfAborted();
    await call('SetInputSettings', {
      inputName: WAITING_TEXT,
      inputSettings: { text: message },
      overlay: true,
    });
  }

  async function start(port, password) {
    const env = { ...process.env, XDG_CONFIG_HOME: root, QT_QPA_PLATFORM: 'xcb' };
    delete env.STREAM_KEY;
    delete env.STREAM_INGEST_URL;
    delete env.TARGET_URLS;
    delete env.STREAM_KEYS_FILE;
    child = spawn('obs', [
      '--multi', '--minimize-to-tray', '--disable-missing-files-check',
      '--profile', COLLECTION, '--collection', COLLECTION,
    ], { env, stdio: 'ignore' });
    childClosed = new Promise((resolve) => child.once('close', resolve));
    child.once('error', () => fail('OBS could not start. Install OBS Studio with obs-websocket v5 on the runner.'));
    child.once('exit', (code, reason) => fail(`OBS exited unexpectedly (${reason ?? code}).`));

    const connectionDeadline = performance.now() + 30000;
    while (true) {
      startupSignal.throwIfAborted();
      try {
        await within(obs.connect(`ws://127.0.0.1:${port}`, password, { rpcVersion: 1 }), 5000, 'OBS connection timed out.');
        await call('GetVersion');
        break;
      } catch {
        await within(obs.disconnect(), 2000, 'OBS disconnect timed out.').catch(() => {});
        if (performance.now() >= connectionDeadline) throw new ObsError('OBS WebSocket did not become ready. Check that OBS starts on the Xvfb display.');
        await delay(400, undefined, { signal: startupSignal });
      }
    }

    obs.on('ConnectionClosed', () => fail('OBS WebSocket connection closed unexpectedly.'));
    obs.on('StreamStateChanged', ({ outputState }) => {
      if (streamRequested && outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') fail('OBS stream output stopped. Check the destination and selected channel key.');
    });

    const settings = await call('GetVideoSettings');
    if (settings.baseWidth !== BASE_WIDTH || settings.baseHeight !== BASE_HEIGHT ||
        settings.outputWidth !== width || settings.outputHeight !== height) {
      throw new ObsError('OBS started with unexpected video settings. Check the selected profile.');
    }

    const { inputKinds } = await call('GetInputKindList');
    const displayKind = inputKinds.includes('xshm_input_v2') ? 'xshm_input_v2' : 'xshm_input';
    if (!inputKinds.includes(displayKind) || !inputKinds.includes('pulse_output_capture')) {
      throw new ObsError('OBS must include the Linux XSHM and PulseAudio capture plugins.');
    }

    const textKind = inputKinds.find((kind) => kind === 'text_ft2_source_v2') ||
      inputKinds.find((kind) => kind === 'text_ft2_source');
    if (textKind) {
      const { sceneItemId } = await call('CreateInput', {
        sceneName: WAITING, inputName: WAITING_TEXT, inputKind: textKind, sceneItemEnabled: true,
        inputSettings: {
          text: 'Waiting for playback',
          font: { face: 'DejaVu Sans', style: 'Bold', size: 64 },
        },
      });
      await call('SetSceneItemTransform', {
        sceneName: WAITING, sceneItemId,
        sceneItemTransform: { positionX: BASE_WIDTH / 2, positionY: BASE_HEIGHT / 2, alignment: 0 },
      });
      canShowStatus = true;
    } else {
      console.warn('[OBS] Linux FreeType text source unavailable. The waiting scene will be blank.');
    }

    await call('CreateScene', { sceneName: LIVE });
    await call('CreateInput', {
      sceneName: LIVE, inputName: 'Chrome Display', inputKind: displayKind,
      inputSettings: { screen: 0, show_cursor: false }, sceneItemEnabled: true,
    });
    await call('CreateInput', {
      sceneName: LIVE, inputName: 'Chrome Audio', inputKind: 'pulse_output_capture',
      inputSettings: { device_id: `${process.env.PULSE_SINK}.monitor` }, sceneItemEnabled: true,
    });
    await call('SetCurrentSceneTransition', { transitionName: 'Cut' });
    await showLive(false);
    console.log('[OBS] Ready. Waiting for verified playback.');
  }

  try {
    const port = await allocatePort();
    const password = randomBytes(24).toString('hex');
    await writeConfig(root, { width, height, bitrate, ingestUrl, streamKey }, port, password);
    startupSignal.throwIfAborted();
    startup = start(port, password);
    await Promise.race([startup, failure]);
    return { showLive, showStatus, close, failure };
  } catch (error) {
    await close();
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof BotError || error.name === 'ObsError' ? error.message : 'The stream bot stopped because of an unexpected error.');
    process.exitCode = 1;
  });
}

module.exports = { readSettings, runSources };
