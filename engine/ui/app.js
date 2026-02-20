(function () {
  const stateUrl = "/state";
  const healthUrl = "/health";
  const statePollMs = 500;
  const healthPollMs = 1500;

  const channelElement = document.getElementById("channel");
  const statusElement = document.getElementById("status");
  const currentElement = document.getElementById("current");
  const nextElement = document.getElementById("next");
  const playbackElement = document.getElementById("playback");
  const clockElement = document.getElementById("clock");
  const noiseCanvas = document.getElementById("noise");
  const colorbarsCanvas = document.getElementById("colorbars");

  if (
    !channelElement ||
    !statusElement ||
    !currentElement ||
    !nextElement ||
    !playbackElement ||
    !clockElement ||
    !noiseCanvas ||
    !colorbarsCanvas
  ) {
    return;
  }

  class NoiseRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = this.canvas.getContext("2d");
      this.sampleCanvas = document.createElement("canvas");
      this.sampleCtx = this.sampleCanvas.getContext("2d");
      this.sampleImageData = null;
      this.running = false;
      this.rafId = null;
      this.resize();
    }

    resize() {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.floor(window.innerWidth * dpr));
      const height = Math.max(1, Math.floor(window.innerHeight * dpr));

      this.canvas.width = width;
      this.canvas.height = height;
      this.canvas.style.width = "100vw";
      this.canvas.style.height = "100vh";

      const sampleWidth = Math.max(1, Math.floor(width / 4));
      const sampleHeight = Math.max(1, Math.floor(height / 4));
      this.sampleCanvas.width = sampleWidth;
      this.sampleCanvas.height = sampleHeight;
      this.sampleImageData = this.sampleCtx ? this.sampleCtx.createImageData(sampleWidth, sampleHeight) : null;
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.renderFrame();
    }

    stop() {
      this.running = false;
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      if (this.ctx) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
    }

    renderFrame() {
      if (!this.running || !this.ctx || !this.sampleCtx || !this.sampleImageData) {
        return;
      }

      const data = this.sampleImageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const shade = Math.floor(Math.random() * 256);
        const alpha = 30 + Math.floor(Math.random() * 140);
        data[i] = shade;
        data[i + 1] = shade;
        data[i + 2] = shade;
        data[i + 3] = alpha;
      }

      this.sampleCtx.putImageData(this.sampleImageData, 0, 0);
      this.ctx.imageSmoothingEnabled = false;
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.drawImage(this.sampleCanvas, 0, 0, this.canvas.width, this.canvas.height);

      this.rafId = requestAnimationFrame(() => this.renderFrame());
    }
  }

  class ColorbarsRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = this.canvas.getContext("2d");
      this.resize();
    }

    resize() {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      this.canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
      this.canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
      this.canvas.style.width = "100vw";
      this.canvas.style.height = "100vh";
      this.draw();
    }

    draw() {
      if (!this.ctx) return;

      const width = this.canvas.width;
      const height = this.canvas.height;
      const topHeight = Math.floor(height * 0.66);
      const middleHeight = Math.floor(height * 0.17);
      const bottomHeight = height - topHeight - middleHeight;

      const topColors = ["#bcbcbc", "#bcbc00", "#00bcbc", "#00bc00", "#bc00bc", "#bc0000", "#0000bc"];
      const middleColors = ["#00214f", "#ffffff", "#32006f", "#000000", "#0a0a0a", "#111111", "#1a1a1a"];
      const bottomColors = ["#1f1f1f", "#ffffff", "#1f1f1f", "#111111", "#1f1f1f", "#000000", "#1f1f1f"];

      this.fillBars(topColors, 0, topHeight);
      this.fillBars(middleColors, topHeight, middleHeight);
      this.fillBars(bottomColors, topHeight + middleHeight, bottomHeight);

      this.ctx.fillStyle = "#000";
      this.ctx.fillRect(0, 0, width, 2);
      this.ctx.fillRect(0, height - 2, width, 2);
    }

    fillBars(colors, startY, bandHeight) {
      if (!this.ctx || bandHeight <= 0) return;
      const barWidth = this.canvas.width / colors.length;
      for (let i = 0; i < colors.length; i += 1) {
        this.ctx.fillStyle = colors[i];
        this.ctx.fillRect(Math.floor(i * barWidth), startY, Math.ceil(barWidth), bandHeight);
      }
    }
  }

  const noiseRenderer = new NoiseRenderer(noiseCanvas);
  const colorbarsRenderer = new ColorbarsRenderer(colorbarsCanvas);

  let stateData = null;
  let healthData = null;
  let stateFetchError = false;
  let healthFetchError = false;

  function formatPlayback(playback) {
    if (!playback) return "-";
    const paused = playback.paused === true ? "paused" : "playing";
    const muted = playback.mute === true ? "muted" : "unmuted";
    const volume =
      typeof playback.volume === "number" && Number.isFinite(playback.volume)
        ? `${Math.round(playback.volume)}%`
        : "?";
    const buffering = playback.buffering ? "buffering" : "live";
    return `${paused} | vol ${volume} | ${muted} | ${buffering}`;
  }

  function computeUiState() {
    const status = stateData?.status || "IDLE";
    const resolving = status === "RESOLVING_CURRENT" || status === "RESOLVING_NEXT";
    const buffering = Boolean(stateData?.playback?.buffering);
    const healthOk = typeof healthData?.ok === "boolean" ? healthData.ok : true;
    const networkError = stateFetchError || healthFetchError;
    const isError = status === "ERROR" || networkError || !healthOk;

    let displayStatus = status;
    if (!stateData && !isError) {
      displayStatus = "LOADING";
    } else if (isError) {
      displayStatus = "ERROR";
    } else if (buffering) {
      displayStatus = "BUFFERING";
    } else if (resolving) {
      displayStatus = "RESOLVING";
    }

    return {
      isError,
      showNoise: !isError && (resolving || buffering),
      displayStatus,
    };
  }

  function render() {
    const uiState = computeUiState();

    document.body.classList.toggle("is-buffering", uiState.showNoise);
    document.body.classList.toggle("is-error", uiState.isError);

    if (uiState.showNoise) {
      noiseRenderer.start();
    } else {
      noiseRenderer.stop();
    }

    if (uiState.isError) {
      colorbarsRenderer.draw();
    }

    channelElement.textContent = stateData?.channelId || "-";
    currentElement.textContent = stateData?.current?.track?.label || "-";
    nextElement.textContent = stateData?.next?.track?.label || "-";
    statusElement.textContent = uiState.displayStatus;
    playbackElement.textContent = formatPlayback(stateData?.playback);
  }

  async function pollState() {
    try {
      const response = await fetch(stateUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error("state_not_ok");
      }
      stateData = await response.json();
      stateFetchError = false;
    } catch {
      stateFetchError = true;
    }
    render();
  }

  async function pollHealth() {
    try {
      const response = await fetch(healthUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error("health_not_ok");
      }
      healthData = await response.json();
      healthFetchError = false;
    } catch {
      healthFetchError = true;
    }
    render();
  }

  function updateClock() {
    clockElement.textContent = new Date().toLocaleTimeString("de-DE", { hour12: false });
  }

  window.addEventListener("resize", () => {
    noiseRenderer.resize();
    colorbarsRenderer.resize();
  });

  updateClock();
  render();
  void pollState();
  void pollHealth();
  setInterval(updateClock, 1000);
  setInterval(() => void pollState(), statePollMs);
  setInterval(() => void pollHealth(), healthPollMs);
})();
