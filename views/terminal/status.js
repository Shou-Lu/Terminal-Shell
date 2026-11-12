const $ = (id) => document.getElementById(id);

const POLL_MS = 3000;
const SERIES_COLORS = {
  cpu: "#00d2ff",
  memory: "#ff6b9d",
  load: "#ffc46b",
};

const state = {
  channel: null,
  active: false,
  timer: null,
  loading: false,
  data: null,
  receivedAt: 0,
  uptimeBase: 0,
  tickTimer: null,
  chart: null,
  sparks: [],
};

const elements = {
  refresh: $("status-refresh"),
  updated: $("status-updated"),
  live: $("status-live"),
  cpu: $("stat-cpu"),
  cpuSub: $("stat-cpu-sub"),
  mem: $("stat-mem"),
  memSub: $("stat-mem-sub"),
  uptime: $("stat-uptime"),
  uptimeSub: $("stat-uptime-sub"),
  disk: $("stat-disk"),
  diskSub: $("stat-disk-sub"),
  diskBar: $("stat-disk-bar"),
  load: $("stat-load"),
  loadSub: $("stat-load-sub"),
  device: $("status-device-info"),
  resource: $("status-resource-info"),
  host: $("status-host"),
  legendCpu: $("legend-cpu"),
  legendMem: $("legend-mem"),
  legendLoad: $("legend-load"),
  chart: $("status-chart"),
  sparks: {
    cpu: $("spark-cpu"),
    memory: $("spark-mem"),
    load: $("spark-load"),
  },
};

let controller = null;

export function initStatusPanel(channel) {
  if (controller) return controller;
  state.channel = channel;
  bindUi();
  controller = {
    activate,
    deactivate,
  };
  return controller;
}

function bindUi() {
  elements.refresh.addEventListener("click", () => refresh(true));
  window.addEventListener("resize", redraw);
  document.addEventListener("visibilitychange", () => {
    if (!state.active) return;
    if (document.hidden) {
      stopPolling();
    } else {
      startPolling();
      refresh(false);
    }
  });
  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(() => redraw());
    observer.observe(elements.chart);
  }
}

function activate() {
  state.active = true;
  refresh(false);
  startPolling();
  startTicking();
}

function deactivate() {
  state.active = false;
  stopPolling();
  stopTicking();
}

function startPolling() {
  if (state.timer) return;
  state.timer = setInterval(() => refresh(false), POLL_MS);
}

function stopPolling() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function startTicking() {
  if (state.tickTimer) return;
  state.tickTimer = setInterval(() => {
    if (!state.data) return;
    const seconds = state.uptimeBase + (Date.now() - state.receivedAt) / 1000;
    elements.uptime.textContent = formatUptime(seconds);
  }, 1000);
}

function stopTicking() {
  if (state.tickTimer) {
    clearInterval(state.tickTimer);
    state.tickTimer = null;
  }
}

async function refresh(manual) {
  if (!state.channel || state.loading) return;
  state.loading = true;
  elements.live?.classList.add("busy");
  if (manual) setUpdated("正在刷新…");
  try {
    const data = await state.channel.post("system/status", {});
    state.data = data;
    state.receivedAt = Date.now();
    state.uptimeBase = Number(data.info?.uptime || 0);
    render(data);
    setUpdated(`更新于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`);
  } catch (error) {
    console.error(error);
    setUpdated(error?.message || "读取设备状态失败", true);
  } finally {
    state.loading = false;
    elements.live?.classList.remove("busy");
  }
}

function render(data) {
  const info = data.info || {};
  const metrics = data.metrics || {};
  const memory = metrics.memory || {};
  const disk = metrics.disk || {};
  const series = data.series || {};

  const cpu = Number(metrics.cpu || 0);
  const memPercent = Number(memory.percent || 0);
  const load = Number(metrics.load || 0);

  elements.cpu.textContent = `${cpu.toFixed(1)}%`;
  elements.cpuSub.textContent = `系统平均 · ${info.cpu_count || "?"} 核`;  elements.mem.textContent = `${memPercent.toFixed(1)}%`;
  elements.memSub.textContent = `${formatBytes(memory.used)} / ${formatBytes(memory.total)}`;
  elements.uptime.textContent = formatUptime(info.uptime || 0);
  elements.uptimeSub.textContent = `启动于 ${formatDateTime(info.boot_time)}`;
  elements.disk.textContent = `${Number(disk.percent || 0).toFixed(1)}%`;
  elements.diskSub.textContent = `${formatBytes(disk.used)} / ${formatBytes(disk.total)}`;
  elements.diskBar.style.width = `${clamp(Number(disk.percent || 0), 0, 100)}%`;
  elements.load.textContent = load.toFixed(2);
  elements.loadSub.textContent = `进程运行 ${formatDuration(info.process_uptime || 0)}`;

  elements.legendCpu.textContent = `CPU ${cpu.toFixed(1)}%`;
  elements.legendMem.textContent = `内存 ${memPercent.toFixed(1)}%`;
  elements.legendLoad.textContent = `负载 ${load.toFixed(2)}`;

  if (elements.host) {
    elements.host.textContent = info.hostname || "";
    elements.host.title = info.hostname || "";
  }

  renderRows(elements.device, [
    ["主机名", info.hostname],
    ["操作系统", info.os],
    ["系统版本", truncate(info.os_version, 60)],
    ["内核", info.kernel],
    ["架构", info.machine],
    ["CPU", truncate(info.cpu_model, 56)],
    ["CPU 核心", info.cpu_count],
    ["Python", info.python],
    ["AstrBot", info.astrbot],
  ]);

  renderRows(elements.resource, [
    ["系统运行时长", formatUptime(info.uptime || 0)],
    ["插件运行时长", formatDuration(info.plugin_uptime || 0)],
    ["进程 PID", metrics.process?.pid],
    ["进程线程", metrics.process?.threads],
    ["内存总量", formatBytes(memory.total)],
    ["内存已用", formatBytes(memory.used)],
    ["内存可用", formatBytes(memory.available)],
    ["磁盘根目录", truncate(disk.path, 46)],
    ["磁盘可用", formatBytes(disk.free)],
    ["采样间隔", `${data.interval || 2} 秒`],
  ]);

  drawAll(series);
}

function renderRows(container, rows) {
  if (!container) return;
  container.replaceChildren();
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "status-row";
    const key = document.createElement("span");
    key.className = "status-row-key";
    key.textContent = label;
    const val = document.createElement("span");
    val.className = "status-row-value";
    val.textContent = value === undefined || value === null || value === "" ? "—" : String(value);
    val.title = val.textContent;
    row.append(key, val);
    container.append(row);
  }
}

function drawAll(series) {
  drawChart(elements.chart, series, { labels: true });
  drawSpark(elements.sparks.cpu, series.cpu, SERIES_COLORS.cpu);
  drawSpark(elements.sparks.memory, series.memory, SERIES_COLORS.memory);
  drawSpark(elements.sparks.load, normalizeLoad(series.load), SERIES_COLORS.load);
}

function normalizeLoad(values) {
  if (!Array.isArray(values)) return [];
  const cores = Math.max(1, Number(state.data?.info?.cpu_count || 1));
  return values.map((value) => clamp((Number(value) / cores) * 100, 0, 100));
}

function redraw() {
  if (state.data) drawAll(state.data.series || {});
}

function prepareCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  return { context, width, height };
}

function drawChart(canvas, series, options = {}) {
  if (!canvas) return;
  const { context, width, height } = prepareCanvas(canvas);
  const cpu = Array.isArray(series.cpu) ? series.cpu : [];
  const memory = Array.isArray(series.memory) ? series.memory : [];
  const count = Math.max(cpu.length, memory.length);
  if (!count) {
    drawPlaceholder(context, width, height, "等待采样…");
    return;
  }

  const pad = { left: 36, right: 12, top: 12, bottom: options.labels ? 22 : 8 };
  const plotWidth = Math.max(1, width - pad.left - pad.right);
  const plotHeight = Math.max(1, height - pad.top - pad.bottom);
  const styles = getComputedStyle(document.documentElement);
  const textColor = styles.getPropertyValue("--muted").trim() || "#8fa4c7";
  const gridColor = document.documentElement.dataset.theme === "light"
    ? "rgba(30, 64, 175, 0.12)"
    : "rgba(255, 255, 255, 0.08)";

  context.save();
  context.font = "10px 'Cascadia Code', Consolas, monospace";
  context.textBaseline = "middle";
  context.lineWidth = 1;

  for (let value = 0; value <= 100; value += 25) {
    const y = pad.top + plotHeight * (1 - value / 100);
    context.strokeStyle = gridColor;
    context.beginPath();
    context.moveTo(pad.left, y);
    context.lineTo(pad.left + plotWidth, y);
    context.stroke();
    context.fillStyle = textColor;
    context.textAlign = "right";
    context.fillText(`${value}%`, pad.left - 7, y);
  }

  const xAt = (index) => pad.left + (count === 1 ? plotWidth : (index / (count - 1)) * plotWidth);
  const yAt = (value) => pad.top + plotHeight * (1 - clamp(Number(value) || 0, 0, 100) / 100);

  if (options.labels && Array.isArray(series.t) && series.t.length) {
    const times = series.t;
    const ticks = Math.min(4, times.length);
    context.fillStyle = textColor;
    context.textAlign = "center";
    context.textBaseline = "top";
    for (let tick = 0; tick < ticks; tick += 1) {
      const index = Math.round((tick / Math.max(1, ticks - 1)) * (times.length - 1));
      const date = new Date(times[index] * 1000);
      const label = date.toLocaleTimeString("zh-CN", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const x = clamp(xAt(index), pad.left + 18, pad.left + plotWidth - 18);
      context.fillText(label, x, pad.top + plotHeight + 7);
    }
  }

  drawSeries(context, cpu, xAt, yAt, plotHeight, SERIES_COLORS.cpu);
  drawSeries(context, memory, xAt, yAt, plotHeight, SERIES_COLORS.memory);
  context.restore();
}

function drawSeries(context, values, xAt, yAt, plotHeight, color) {
  if (!values.length) return;
  const bottom = yAt(0);
  context.beginPath();
  values.forEach((value, index) => {
    const x = xAt(index);
    const y = yAt(value);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.lineWidth = 1.8;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.strokeStyle = color;
  context.shadowColor = color;
  context.shadowBlur = 8;
  context.stroke();
  context.shadowBlur = 0;

  context.lineTo(xAt(values.length - 1), bottom);
  context.lineTo(xAt(0), bottom);
  context.closePath();
  const gradient = context.createLinearGradient(0, 0, 0, bottom);
  gradient.addColorStop(0, withAlpha(color, 0.22));
  gradient.addColorStop(1, withAlpha(color, 0));
  context.fillStyle = gradient;
  context.fill();
}

function drawSpark(canvas, values, color) {
  if (!canvas) return;
  const { context, width, height } = prepareCanvas(canvas);
  if (!Array.isArray(values) || !values.length) {
    drawPlaceholder(context, width, height, "");
    return;
  }
  const pad = 4;
  const plotWidth = Math.max(1, width - pad * 2);
  const plotHeight = Math.max(1, height - pad * 2);
  const xAt = (index) =>
    pad + (values.length === 1 ? plotWidth : (index / (values.length - 1)) * plotWidth);
  const yAt = (value) => pad + plotHeight * (1 - clamp(Number(value) || 0, 0, 100) / 100);

  context.beginPath();
  values.forEach((value, index) => {
    const x = xAt(index);
    const y = yAt(value);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.lineTo(xAt(values.length - 1), height - pad);
  context.lineTo(xAt(0), height - pad);
  context.closePath();
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, withAlpha(color, 0.3));
  gradient.addColorStop(1, withAlpha(color, 0));
  context.fillStyle = gradient;
  context.fill();

  context.beginPath();
  values.forEach((value, index) => {
    const x = xAt(index);
    const y = yAt(value);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.lineWidth = 1.4;
  context.lineJoin = "round";
  context.strokeStyle = color;
  context.stroke();
}

function drawPlaceholder(context, width, height, text) {
  if (!text) return;
  context.fillStyle = "rgba(140, 160, 190, 0.7)";
  context.font = "11px 'Segoe UI', sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, width / 2, height / 2);
}

function withAlpha(hex, alpha) {
  const value = String(hex || "").replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return `rgba(0, 210, 255, ${alpha})`;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function setUpdated(text, error = false) {
  if (!elements.updated) return;
  elements.updated.textContent = text;
  elements.updated.classList.toggle("error", error);
}

function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) {
    return `${days}天 ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) return `${total} 秒`;
  if (total < 3600) return `${Math.floor(total / 60)} 分 ${total % 60} 秒`;
  if (total < 86400) {
    return `${Math.floor(total / 3600)} 时 ${Math.floor((total % 3600) / 60)} 分`;
  }
  return `${Math.floor(total / 86400)} 天 ${Math.floor((total % 86400) / 3600)} 时`;
}

function formatDateTime(epochSeconds) {
  if (!epochSeconds) return "—";
  try {
    return new Date(Number(epochSeconds) * 1000).toLocaleString("zh-CN", {
      hour12: false,
    });
  } catch (error) {
    return "—";
  }
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value < 1024) return `${value.toFixed(0)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value < 1024 * 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  return `${(value / 1024 / 1024 / 1024 / 1024).toFixed(2)} TB`;
}

function truncate(value, max) {
  const text = value === undefined || value === null ? "" : String(value);
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}
