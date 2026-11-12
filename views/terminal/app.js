import {
  SecureChannel,
  b64encode,
  b64decode,
  utf8,
} from "./crypto.js";
import { initFilesPanel } from "./files.js";
import { initStatusPanel } from "./status.js";

const $ = (id) => document.getElementById(id);

const elements = {
  app: $("app"),
  customBg: $("custom-bg"),
  workspace: $("workspace"),
  filesView: $("files-view"),
  statusView: $("status-view"),
  viewTabs: Array.from(document.querySelectorAll(".view-tab")),
  tabstrip: $("tabstrip"),
  terminals: $("terminals"),
  empty: $("empty-state"),
  emptyNew: $("empty-new"),
  newTab: $("new-tab"),
  bgBtn: $("bg-btn"),
  helpBtn: $("help-btn"),
  cryptoBadge: $("crypto-badge"),
  statusDot: $("status-dot"),
  statusText: $("status-text"),
  statusConnection: $("status-connection"),
  statusEncryption: $("status-encryption"),
  statusSession: $("status-session"),
  statusSize: $("status-size"),
  statusClock: $("status-clock"),
  toast: $("toast"),
  bgModal: $("bg-modal"),
  bgFile: $("bg-file"),
  bgPreview: $("bg-preview"),
  bgApply: $("bg-apply"),
  bgReset: $("bg-reset"),
  bgStatus: $("bg-status"),
  dropzone: $("dropzone"),
  helpModal: $("help-modal"),
};

const SETTINGS_KEY = "terminal-shell:settings";
const VIEW_KEY = "terminal-shell:view";
const TABS_KEY = "terminal-shell:tabs";
const OWNER_KEY = "terminal-shell:owner";

const DEFAULT_SETTINGS = {
  blur: 12,
  veil: 0.25,
  fontSize: 14,
};

const DARK_XTERM_THEME = {
  background: "rgba(0,0,0,0)",
  foreground: "#e7efff",
  cursor: "#00d2ff",
  cursorAccent: "#05070f",
  selectionBackground: "rgba(0,210,255,0.24)",
  black: "#0b1220",
  red: "#ff7a90",
  green: "#00d2a8",
  yellow: "#ffc46b",
  blue: "#6ea8ff",
  magenta: "#c084fc",
  cyan: "#00d2ff",
  white: "#dfe9ff",
  brightBlack: "#5c7299",
  brightRed: "#ff9bac",
  brightGreen: "#6ff0b6",
  brightYellow: "#ffd99b",
  brightBlue: "#9cc2ff",
  brightMagenta: "#d8b4fe",
  brightCyan: "#a5f3ff",
  brightWhite: "#ffffff",
};

const LIGHT_XTERM_THEME = {
  background: "rgba(0,0,0,0)",
  foreground: "#17233a",
  cursor: "#0e7490",
  cursorAccent: "#f7fbff",
  selectionBackground: "rgba(14,116,144,0.2)",
  black: "#1c2738",
  red: "#c0263f",
  green: "#0f7a58",
  yellow: "#9a5b06",
  blue: "#1d4ed8",
  magenta: "#7e22ce",
  cyan: "#0e7490",
  white: "#475569",
  brightBlack: "#64748b",
  brightRed: "#e11d48",
  brightGreen: "#059669",
  brightYellow: "#b45309",
  brightBlue: "#2563eb",
  brightMagenta: "#9333ea",
  brightCyan: "#0891b2",
  brightWhite: "#0f172a",
};

const TOUCH_KEYS = [
  ["Esc", "\x1b"],
  ["Tab", "\t"],
  ["^C", "\x03"],
  ["^D", "\x04"],
  ["↑", "\x1b[A"],
  ["↓", "\x1b[B"],
  ["←", "\x1b[D"],
  ["→", "\x1b[C"],
  ["Home", "\x1b[H"],
  ["End", "\x1b[F"],
];

const state = {
  tabs: new Map(),
  order: [],
  active: null,
  owner: getOwner(),
  limits: { max_sessions: 8 },
  settings: loadSettings(),
  connected: false,
  connecting: false,
  lastSeq: 0,
  streamSub: null,
  streamRetry: 0,
  reconnectTimer: null,
  openTimer: null,
  pollTimer: null,
  polling: false,
  decryptChain: Promise.resolve(),
  creating: false,
  recovering: false,
  lastStreamErrorAt: 0,
  prefTimer: null,
  prefsLoaded: false,
  toastTimer: null,
  contextMenu: null,
  previewUrl: null,
  pendingBackground: null,
  backgroundUrl: null,
  hasBackground: false,
  theme: "dark",
  fatal: false,
  view: "terminal",
};

let bridge = null;
let channel = null;
let filesController = null;
let statusController = null;

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */
init().catch((error) => {
  console.error(error);
  showFatal("页面初始化失败", error?.message || String(error));
});

async function init() {
  const initialTheme = document.documentElement.dataset.theme;
  applyTheme(initialTheme ? initialTheme !== "light" : true);
  bindUi();
  startClock();
  applySettings({ fit: false, save: false });

  bridge = await waitForBridge();
  if (!bridge) {
    showFatal(
      "没有找到 AstrBot 插件桥接",
      "请在 AstrBot WebUI 的插件详情页中打开此视图，而不是直接访问 HTML 文件。",
    );
    return;
  }

  let context = null;
  try {
    context = bridge.ready ? await bridge.ready() : null;
  } catch (error) {
    console.warn("bridge.ready failed", error);
  }
  if (context) {
    applyTheme(context.isDark !== false);
    if (typeof bridge.onContext === "function") {
      bridge.onContext((next) => applyTheme(next?.isDark !== false));
    }
  }
  if (typeof bridge.t === "function") {
    document.title = bridge.t(
      "views.terminal.title",
      "Terminal Shell终端",
    );
  }

  channel = new SecureChannel(bridge);
  setConnection("connecting", "正在协商加密密钥…");
  try {
    await channel.ready();
  } catch (error) {
    showFatal("无法建立加密通道", error?.message || String(error));
    return;
  }

  if (channel.limits) state.limits = { ...state.limits, ...channel.limits };
  updateCryptoBadge(true);
  updateSessionLabel();
  updateEncryptionLabel();
  setConnection("connecting", "加密通道已建立，正在恢复终端…");

  try {
    await restoreTerminals();
  } catch (error) {
    console.error(error);
    showFatal("无法读取终端列表", error?.message || String(error));
    return;
  }

  await loadPreferences();
  loadBackground();
  startConnectionWatchdog();
  setView(loadSavedView(), { persist: false });
}

/* ------------------------------------------------------------------ */
/* View switching (terminal / files / status)                         */
/* ------------------------------------------------------------------ */
const VIEW_NAMES = ["terminal", "files", "status"];

function normalizeView(name) {
  return VIEW_NAMES.includes(name) ? name : "terminal";
}

function loadSavedView() {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    return normalizeView(saved || "terminal");
  } catch (error) {
    return "terminal";
  }
}

function ensureFilesController() {
  if (!channel) return null;
  if (!filesController) filesController = initFilesPanel(channel);
  return filesController;
}

function ensureStatusController() {
  if (!channel) return null;
  if (!statusController) statusController = initStatusPanel(channel);
  return statusController;
}

function setView(name, options = {}) {
  const next = normalizeView(name);
  const previous = state.view;
  const changed = previous !== next;

  if (changed && previous === "status") statusController?.deactivate();

  state.view = next;
  document.body.dataset.view = next;

  for (const tab of elements.viewTabs) {
    const active = tab.dataset.view === next;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  }

  const showTerminal = next === "terminal";
  elements.workspace.classList.toggle("hidden", !showTerminal);
  elements.filesView.classList.toggle("hidden", next !== "files");
  elements.statusView.classList.toggle("hidden", next !== "status");

  if (next === "terminal") {
    if (state.active) {
      requestAnimationFrame(() => fitTab(state.tabs.get(state.active)));
    }
  } else if (next === "files") {
    ensureFilesController()?.activate();
  } else if (next === "status") {
    ensureStatusController()?.activate();
  }

  if (options.persist !== false) {
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch (error) {
      // localStorage can be unavailable inside sandboxed frames.
    }
  }
}

function startConnectionWatchdog() {
  setInterval(async () => {
    if (document.hidden || state.connected || state.recovering) return;
    if (!channel || state.tabs.size === 0) return;
    try {
      if (!channel.readyState) {
        await recoverEncryption();
        return;
      }
      await connectStream(state.lastSeq);
    } catch (error) {
      // The next tick will retry; polling (if active) also keeps trying.
    }
  }, 6000);
}

async function waitForBridge() {
  for (let i = 0; i < 140; i += 1) {
    const candidate =
      window.AstrBotPluginView || window.AstrBotPluginPage || null;
    if (candidate) return candidate;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Terminals                                                          */
/* ------------------------------------------------------------------ */
async function restoreTerminals() {
  const data = await channel.post("list", { owner: state.owner });
  if (data.limits) state.limits = { ...state.limits, ...data.limits };
  state.lastSeq = Number(data.seq) || 0;

  const stored = loadTabState();
  const storedTitles = new Map(
    (stored?.tabs || [])
      .filter((item) => item && item.sid)
      .map((item) => [item.sid, item.title]),
  );

  for (const info of data.sessions || []) {
    addTab(info, {
      activate: false,
      title: storedTitles.get(info.sid),
    });
  }

  if (state.order.length) {
    const wanted = stored?.active;
    const active =
      wanted && state.tabs.has(wanted) ? wanted : state.order[0];
    activateTab(active, { focus: false });
    saveTabs();
  } else {
    await createTerminal();
  }

  await connectStream(state.lastSeq);
  updateEmptyState();
}

async function createTerminal() {
  if (state.fatal) return;
  if (state.creating) return;
  if (!channel) {
    toast("加密通道尚未就绪，请稍候", true);
    return;
  }
  if (state.tabs.size >= (state.limits.max_sessions || 8)) {
    toast(
      `每个用户最多同时打开 ${state.limits.max_sessions || 8} 个终端`,
      true,
    );
    return;
  }

  state.creating = true;
  elements.newTab.disabled = true;
  const active = state.active ? state.tabs.get(state.active) : null;
  const cols =
    active?.term?.cols ||
    Math.max(40, Math.floor((window.innerWidth - 90) / 8.2));
  const rows =
    active?.term?.rows ||
    Math.max(12, Math.floor((window.innerHeight - 210) / 18));

  try {
    const info = await channel.post("session", {
      owner: state.owner,
      cols,
      rows,
    });
    if (info.limits) state.limits = { ...state.limits, ...info.limits };
    addTab(info, { activate: true });
    toast("终端已创建");
  } catch (error) {
    toast(error?.message || "创建终端失败", true);
  } finally {
    state.creating = false;
    elements.newTab.disabled = false;
  }
}

function addTab(info, options = {}) {
  if (!info?.sid) return null;
  const existing = state.tabs.get(info.sid);
  if (existing) {
    if (options.activate) activateTab(info.sid);
    return existing;
  }

  const sid = info.sid;
  const tabEl = document.createElement("div");
  tabEl.className = "tab connecting";
  tabEl.dataset.sid = sid;
  tabEl.draggable = true;
  tabEl.setAttribute("role", "tab");
  tabEl.setAttribute("aria-selected", "false");

  const dot = document.createElement("span");
  dot.className = "tab-dot";
  dot.setAttribute("aria-hidden", "true");

  const titleEl = document.createElement("span");
  titleEl.className = "tab-title";
  titleEl.textContent = options.title || info.title || "Terminal";

  const closeEl = document.createElement("button");
  closeEl.className = "tab-close";
  closeEl.type = "button";
  closeEl.textContent = "×";
  closeEl.title = "关闭终端";
  closeEl.setAttribute("aria-label", "关闭终端");

  tabEl.append(dot, titleEl, closeEl);
  elements.tabstrip.append(tabEl);

  const pane = document.createElement("section");
  pane.className = "terminal-pane";
  pane.dataset.sid = sid;
  pane.setAttribute("role", "tabpanel");

  const meta = buildPaneMeta(info);
  const host = document.createElement("div");
  host.className = "xterm-host";
  const touch = buildTouchKeys();
  pane.append(meta.element, host, touch.element);
  elements.terminals.append(pane);

  const tab = {
    sid,
    title: titleEl.textContent,
    titleEl,
    tabEl,
    closeEl,
    pane,
    meta,
    host,
    term: null,
    fit: null,
    cols: Number(info.cols) || 100,
    rows: Number(info.rows) || 30,
    alive: info.alive !== false,
    backend: info.backend || "pty",
    shell: info.shell || "",
    cwd: info.cwd || "",
    inputQueue: [],
    inputTimer: null,
    sendChain: Promise.resolve(),
    resizeTimer: null,
    resizeObserver: null,
    lastErrorAt: 0,
  };

  tabEl.addEventListener("click", () => activateTab(sid));
  closeEl.addEventListener("click", (event) => {
    event.stopPropagation();
    removeTab(sid, { notify: true });
  });
  tabEl.addEventListener("auxclick", (event) => {
    if (event.button === 1) {
      event.preventDefault();
      removeTab(sid, { notify: true });
    }
  });
  titleEl.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    startRename(tab);
  });
  bindTabDrag(tab);

  createTerminalInstance(tab);
  state.tabs.set(sid, tab);
  state.order.push(sid);

  touch.buttons.forEach(([label, sequence]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      queueInput(tab, sequence);
      tab.term?.focus();
    });
    touch.element.append(button);
  });

  if (info.history) {
    try {
      const history = b64decode(info.history);
      if (history.length) tab.term.write(history);
    } catch (error) {
      console.warn("invalid history", error);
    }
  }

  if (!tab.alive) markExited(tab, info.exit_code, info.exit_reason || "exit", {
    silent: true,
  });
  else tabEl.classList.remove("connecting");

  updateEmptyState();
  saveTabs();

  if (options.activate || state.order.length === 1) {
    activateTab(sid, { focus: options.focus !== false });
  }
  return tab;
}

function buildPaneMeta(info) {
  const element = document.createElement("div");
  element.className = "pane-meta";

  const path = document.createElement("div");
  path.className = "pane-path";
  const shell = document.createElement("span");
  shell.className = "pane-shell";
  shell.textContent = basename(info.shell || "shell");
  const sep = document.createElement("span");
  sep.className = "pane-sep";
  sep.textContent = "/";
  const cwd = document.createElement("span");
  cwd.className = "pane-cwd";
  cwd.textContent = info.cwd || "~";
  path.append(shell, sep, cwd);

  const badge = document.createElement("span");
  badge.className = "pane-badge";
  badge.textContent = info.backend || "pty";

  const actions = document.createElement("div");
  actions.className = "pane-actions";

  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "清空";
  clear.title = "清空屏幕";
  clear.addEventListener("click", () => {
    const tab = state.tabs.get(element.closest(".terminal-pane")?.dataset.sid);
    tab?.term?.clear();
    tab?.term?.focus();
  });

  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "复制";
  copy.title = "复制全部输出";
  copy.addEventListener("click", () => {
    const tab = state.tabs.get(element.closest(".terminal-pane")?.dataset.sid);
    if (!tab) return;
    copyText(bufferText(tab));
  });

  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "关闭";
  close.title = "关闭终端";
  close.addEventListener("click", () => {
    const tab = state.tabs.get(element.closest(".terminal-pane")?.dataset.sid);
    if (tab) removeTab(tab.sid, { notify: true });
  });

  actions.append(clear, copy, close);
  element.append(path, badge, actions);
  return { element, shell, cwd, badge };
}

function buildTouchKeys() {
  const element = document.createElement("div");
  element.className = "touch-keys";
  return { element, buttons: TOUCH_KEYS };
}

function createTerminalInstance(tab) {
  const term = new Terminal({
    cols: tab.cols,
    rows: tab.rows,
    fontFamily:
      '"Cascadia Code", "JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
    fontSize: state.settings.fontSize,
    fontWeight: "400",
    fontWeightBold: "650",
    lineHeight: 1.22,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorWidth: 2,
    allowTransparency: true,
    scrollback: 5000,
    smoothScrollDuration: 0,
    macOptionIsMeta: true,
    rightClickSelectsWord: false,
    theme:
      state.theme === "light" ? LIGHT_XTERM_THEME : DARK_XTERM_THEME,
  });

  const fit = new FitAddon.FitAddon();
  const links = new WebLinksAddon.WebLinksAddon((event, uri) => {
    event.preventDefault();
    copyText(uri);
  });
  term.loadAddon(fit);
  term.loadAddon(links);
  term.open(tab.host);

  tab.term = term;
  tab.fit = fit;

  term.onData((data) => {
    // PowerShell/ConPTY answers its device-attribute query; without
    // PSReadline the response would be echoed as literal "^[[?1;2c".
    if (tab.backend === "conpty") {
      data = data.replace(/\x1b\[\?1;2c/g, "");
      if (!data) return;
    }
    queueInput(tab, data);
  });
  term.onResize(({ cols, rows }) => {
    tab.cols = cols;
    tab.rows = rows;
    scheduleResize(tab);
    updateStatusSize();
  });
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    const key = event.key.toLowerCase();
    if (event.ctrlKey && event.shiftKey && key === "c") {
      const selection = term.getSelection();
      if (selection) copyText(selection);
      return false;
    }
    if (event.ctrlKey && event.shiftKey && key === "v") {
      pasteTo(tab);
      return false;
    }
    return true;
  });

  tab.host.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    term.focus();
    showContextMenu(tab, event.clientX, event.clientY);
  });

  if ("ResizeObserver" in window) {
    tab.resizeObserver = new ResizeObserver(() => {
      if (state.active === tab.sid) fitTab(tab);
    });
    tab.resizeObserver.observe(tab.host);
  }

  requestAnimationFrame(() => fitTab(tab));
}

function fitTab(tab) {
  if (!tab?.term || !tab.pane.classList.contains("active")) return;
  try {
    tab.fit.fit();
  } catch (error) {
    console.warn("fit failed", error);
  }
}

function activateTab(sid, options = {}) {
  const tab = state.tabs.get(sid);
  if (!tab) return;
  for (const item of state.tabs.values()) {
    const active = item.sid === sid;
    item.pane.classList.toggle("active", active);
    item.tabEl.classList.toggle("active", active);
    item.tabEl.setAttribute("aria-selected", active ? "true" : "false");
  }
  state.active = sid;
  saveTabs();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fitTab(tab);
      if (options.focus !== false) tab.term?.focus();
    });
  });
  updateStatusSize();
  scrollTabIntoView(tab.tabEl);
}

function scrollTabIntoView(element) {
  if (!element) return;
  element.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function removeTab(sid, options = {}) {
  const tab = state.tabs.get(sid);
  if (!tab) return;
  const index = state.order.indexOf(sid);

  if (options.notify !== false && channel) {
    channel.post("close", { sid }).catch(() => {});
  }

  if (tab.inputTimer) clearTimeout(tab.inputTimer);
  if (tab.resizeTimer) clearTimeout(tab.resizeTimer);
  tab.inputQueue.length = 0;
  tab.resizeObserver?.disconnect();
  try {
    tab.term?.dispose();
  } catch (error) {
    console.warn("dispose failed", error);
  }
  tab.pane.remove();
  tab.tabEl.remove();
  state.tabs.delete(sid);
  if (index >= 0) state.order.splice(index, 1);

  if (state.active === sid) {
    state.active = null;
    const next = state.order[Math.min(index, state.order.length - 1)];
    if (next) activateTab(next);
  }
  updateEmptyState();
  updateStatusSize();
  saveTabs();
}

function markExited(tab, code, reason, options = {}) {
  if (!tab) return;
  tab.alive = false;
  tab.tabEl.classList.add("exited");
  tab.tabEl.classList.remove("connecting");
  tab.tabEl.title = `进程已退出${code != null ? ` · code ${code}` : ""}`;
  if (!options.silent) {
    const suffix = code != null ? ` · exit ${code}` : "";
    const message =
      reason === "closed" ? "终端已关闭" : `进程已结束${suffix}`;
    tab.term?.write(
      `\r\n\x1b[38;2;255;122;144m[${message}]\x1b[0m\r\n`,
    );
  }
}

function startRename(tab) {
  if (tab.renaming) return;
  tab.renaming = true;
  const input = document.createElement("input");
  input.className = "tab-title-input";
  input.value = tab.title;
  input.maxLength = 48;
  tab.titleEl.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = (commit) => {
    if (finished) return;
    finished = true;
    tab.renaming = false;
    if (commit) {
      const value = input.value.trim();
      if (value) {
        tab.title = value.slice(0, 48);
        tab.titleEl.textContent = tab.title;
        tab.tabEl.title = tab.title;
        saveTabs();
      }
    }
    input.replaceWith(tab.titleEl);
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (event) => event.stopPropagation());
}

function bindTabDrag(tab) {
  tab.tabEl.addEventListener("dragstart", (event) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", tab.sid);
    tab.tabEl.classList.add("dragging");
  });
  tab.tabEl.addEventListener("dragend", () => {
    tab.tabEl.classList.remove("dragging");
    for (const item of state.tabs.values()) {
      item.tabEl.classList.remove("drop-target");
    }
  });
  tab.tabEl.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    tab.tabEl.classList.add("drop-target");
  });
  tab.tabEl.addEventListener("dragleave", () => {
    tab.tabEl.classList.remove("drop-target");
  });
  tab.tabEl.addEventListener("drop", (event) => {
    event.preventDefault();
    tab.tabEl.classList.remove("drop-target");
    const sourceSid = event.dataTransfer.getData("text/plain");
    if (!sourceSid || sourceSid === tab.sid) return;
    const from = state.order.indexOf(sourceSid);
    const to = state.order.indexOf(tab.sid);
    if (from < 0 || to < 0) return;
    state.order.splice(from, 1);
    state.order.splice(to, 0, sourceSid);
    for (const sid of state.order) {
      const item = state.tabs.get(sid);
      if (item) elements.tabstrip.append(item.tabEl);
    }
    saveTabs();
  });
}

/* ------------------------------------------------------------------ */
/* Input / resize                                                     */
/* ------------------------------------------------------------------ */
function queueInput(tab, data) {
  if (!tab || !data) return;
  if (!tab.alive) {
    toast("终端进程已结束，请新建标签", true);
    return;
  }
  tab.inputQueue.push(data);
  if (!tab.inputTimer) {
    tab.inputTimer = setTimeout(() => flushInput(tab), 12);
  }
}

function flushInput(tab) {
  tab.inputTimer = null;
  const text = tab.inputQueue.join("");
  tab.inputQueue.length = 0;
  if (!text) return;
  const bytes = utf8(text);
  tab.sendChain = tab.sendChain
    .then(async () => {
      for (let offset = 0; offset < bytes.length; offset += 32768) {
        await channel.post("input", {
          sid: tab.sid,
          data: b64encode(bytes.subarray(offset, offset + 32768)),
        });
      }
    })
    .catch((error) => {
      const now = Date.now();
      if (now - tab.lastErrorAt > 1500) {
        tab.lastErrorAt = now;
        toast(error?.message || "写入终端失败", true);
      }
    });
}

function scheduleResize(tab) {
  if (!tab?.alive) return;
  if (tab.resizeTimer) clearTimeout(tab.resizeTimer);
  tab.resizeTimer = setTimeout(() => {
    tab.resizeTimer = null;
    if (!tab.alive || !channel) return;
    channel
      .post("resize", { sid: tab.sid, cols: tab.cols, rows: tab.rows })
      .catch(() => {});
  }, 160);
}

/* ------------------------------------------------------------------ */
/* Stream                                                             */
/* ------------------------------------------------------------------ */
async function connectStream(since) {
  if (!channel?.sid) return;
  if (!bridge?.subscribeSSE) {
    startPolling();
    return;
  }
  if (state.streamSub && bridge.unsubscribeSSE) {
    try {
      await bridge.unsubscribeSSE(state.streamSub);
    } catch (error) {
      // Ignore stale subscription cleanup failures.
    }
    state.streamSub = null;
  }

  setConnection("connecting", "正在订阅加密输出流…");
  try {
    const subscription = await bridge.subscribeSSE(
      "stream",
      {
        onOpen() {
          if (state.openTimer) {
            clearTimeout(state.openTimer);
            state.openTimer = null;
          }
          state.connected = true;
          state.streamRetry = 0;
          stopPolling();
          updateCryptoBadge(true);
          updateSessionLabel();
          updateEncryptionLabel();
          setConnection("online", "加密通道已连接");
        },
        onMessage(event) {
          enqueueEvent(event);
        },
        onError() {
          handleStreamError();
        },
      },
      { sid: channel.sid, since },
    );
    state.streamSub = subscription;
    if (state.openTimer) clearTimeout(state.openTimer);
    state.openTimer = setTimeout(() => {
      state.openTimer = null;
      if (!state.connected && state.streamSub === subscription) {
        handleStreamError();
      }
    }, 2500);
  } catch (error) {
    console.warn("SSE failed", error);
    state.connected = false;
    startPolling();
    scheduleReconnect();
  }
}

function handleStreamError() {
  const now = Date.now();
  if (now - state.lastStreamErrorAt < 700) return;
  state.lastStreamErrorAt = now;
  if (state.openTimer) {
    clearTimeout(state.openTimer);
    state.openTimer = null;
  }
  state.connected = false;
  const subscription = state.streamSub;
  state.streamSub = null;
  if (subscription && bridge?.unsubscribeSSE) {
    try {
      Promise.resolve(bridge.unsubscribeSSE(subscription)).catch(() => {});
    } catch (error) {
      // Ignore stale subscription cleanup failures.
    }
  }
  setConnection("connecting", "输出流中断，正在重连…");
  updateCryptoBadge(true);
  state.streamRetry += 1;
  if (state.streamRetry === 3) {
    startPolling();
    // The server may have restarted and forgotten the old AES session.
    recoverEncryption();
  }
  scheduleReconnect();
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  const delay = Math.min(
    20000,
    700 * Math.pow(1.7, Math.min(state.streamRetry, 6)),
  );
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (!state.connected && !state.recovering) {
      connectStream(state.lastSeq);
    }
  }, delay);
}

function enqueueEvent(event) {
  state.decryptChain = state.decryptChain
    .then(async () => {
      let envelope = event?.parsed ?? event?.raw ?? event;
      if (typeof envelope === "string") {
        try {
          envelope = JSON.parse(envelope);
        } catch (error) {
          return;
        }
      }
      if (!envelope || envelope.a !== "stream") return;
      if (envelope.sid && channel.sid && envelope.sid !== channel.sid) {
        return;
      }
      const payload = await channel.decryptEvent(envelope);
      handleEvent(payload);
    })
    .catch((error) => {
      console.warn("stream decrypt failed", error);
      updateCryptoBadge(false);
      recoverEncryption();
    });
}

function handleEvent(event) {
  if (!event || typeof event !== "object") return;
  if (Number.isFinite(event.q)) {
    if (event.q <= state.lastSeq) return;
    state.lastSeq = event.q;
  }

  if (event.t === "o") {
    const tab = state.tabs.get(event.s);
    if (!tab) return;
    try {
      tab.term.write(b64decode(event.d || ""));
    } catch (error) {
      console.warn("terminal write failed", error);
    }
    return;
  }

  if (event.t === "ready") {
    const tab = state.tabs.get(event.s);
    if (!tab) return;
    tab.alive = true;
    tab.shell = event.shell || tab.shell;
    tab.cwd = event.cwd || tab.cwd;
    tab.backend = event.backend || tab.backend;
    tab.tabEl.classList.remove("connecting", "exited");
    updatePaneMeta(tab);
    return;
  }

  if (event.t === "exit") {
    const tab = state.tabs.get(event.s);
    if (!tab) return;
    if (event.reason === "closed") {
      removeTab(tab.sid, { notify: false });
    } else {
      markExited(tab, event.code, event.reason || "exit");
    }
  }
}

async function recoverEncryption() {
  if (state.recovering || !channel) return;
  state.recovering = true;
  try {
    if (state.streamSub && bridge?.unsubscribeSSE) {
      try {
        await bridge.unsubscribeSSE(state.streamSub);
      } catch (error) {
        // Ignore.
      }
    }
    state.streamSub = null;
    await channel.reset();
    await channel.ready();
    updateCryptoBadge(true);
    updateSessionLabel();
    updateEncryptionLabel();
    await refreshAfterRecovery();
    await connectStream(state.lastSeq);
  } catch (error) {
    console.error("encryption recovery failed", error);
    updateCryptoBadge(false);
    setConnection("offline", "加密通道恢复失败，请刷新页面");
  } finally {
    state.recovering = false;
  }
}

async function refreshAfterRecovery() {
  try {
    const data = await channel.post("list", { owner: state.owner });
    if (data.limits) state.limits = { ...state.limits, ...data.limits };
    state.lastSeq = Number(data.seq) || 0;
    const alive = new Set(
      (data.sessions || []).map((session) => session.sid),
    );
    for (const tab of state.tabs.values()) {
      if (tab.alive && !alive.has(tab.sid)) {
        markExited(tab, null, "closed");
      }
    }
  } catch (error) {
    console.warn("session refresh failed", error);
  }
}

function startPolling() {
  if (state.pollTimer) return;
  setConnection("connecting", "SSE 不可用，使用加密轮询");
  state.pollTimer = setInterval(pollOnce, 120);
  pollOnce();
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function pollOnce() {
  if (state.polling || !channel?.sid) return;
  state.polling = true;
  try {
    const data = await channel.post("poll", { since: state.lastSeq });
    for (const event of data.events || []) handleEvent(event);
    if (Number.isFinite(data.seq)) {
      state.lastSeq = data.seq;
    }
    if (!state.connected) {
      state.connected = true;
      updateCryptoBadge(true);
      updateSessionLabel();
      updateEncryptionLabel();
      setConnection("online", "加密轮询已连接");
    }
  } catch (error) {
    state.connected = false;
    setConnection("offline", "轮询中断，正在重试…");
  } finally {
    state.polling = false;
  }
}

/* ------------------------------------------------------------------ */
/* Background                                                         */
/* ------------------------------------------------------------------ */
function setBackgroundImage(bytes, mime) {
  clearBackgroundImage();
  if (!bytes?.length) return;
  const blob = new Blob([bytes], { type: mime || "image/jpeg" });
  state.backgroundUrl = URL.createObjectURL(blob);
  state.hasBackground = true;
  elements.customBg.style.backgroundImage = `url("${state.backgroundUrl}")`;
  document.body.classList.add("has-custom-bg");
}

function clearBackgroundImage() {
  if (state.backgroundUrl) {
    URL.revokeObjectURL(state.backgroundUrl);
    state.backgroundUrl = null;
  }
  state.hasBackground = false;
  if (elements.customBg) {
    elements.customBg.style.backgroundImage = "";
  }
  document.body.classList.remove("has-custom-bg");
}

async function loadBackground() {
  if (!channel) return;
  try {
    const data = await channel.post("background/get", {});
    if (data.exists && data.data) {
      setBackgroundImage(
        b64decode(data.data),
        data.mime || "image/jpeg",
      );
    } else {
      clearBackgroundImage();
    }
  } catch (error) {
    console.warn("background load failed", error);
  }
}

async function prepareBackground(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    toast("请选择图片文件", true);
    return;
  }
  const limit = state.limits.max_upload_bytes || 8 * 1024 * 1024;
  if (file.size > 32 * 1024 * 1024) {
    toast("原图过大，请选择 32 MB 以内的图片", true);
    return;
  }
  elements.bgStatus.textContent = "正在压缩图片…";
  state.pendingBackground = null;
  elements.bgApply.disabled = true;
  try {
    const bitmap = await createImageBitmap(file);
    const maxSide = 1600;
    const scale = Math.min(
      1,
      maxSide / Math.max(bitmap.width, bitmap.height),
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (result) =>
          result ? resolve(result) : reject(new Error("图片编码失败")),
        "image/jpeg",
        0.9,
      );
    });
    if (blob.size > limit) {
      throw new Error(
        `压缩后仍超过 ${Math.round(limit / 1024 / 1024)} MB 限制`,
      );
    }
    state.pendingBackground = { blob, mime: "image/jpeg" };
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = URL.createObjectURL(blob);
    elements.bgPreview.src = state.previewUrl;
    elements.bgPreview.hidden = false;
    elements.bgApply.disabled = false;
    elements.bgStatus.textContent = `已准备 ${width}×${height} · ${formatBytes(
      blob.size,
    )}，点击应用后加密上传。`;
  } catch (error) {
    console.error(error);
    elements.bgStatus.textContent = error?.message || "图片处理失败";
    toast(error?.message || "图片处理失败", true);
  }
}

async function applyBackground() {
  if (!state.pendingBackground || !channel) return;
  elements.bgApply.disabled = true;
  elements.bgReset.disabled = true;
  elements.bgStatus.textContent = "正在加密并上传背景…";
  try {
    const { blob, mime } = state.pendingBackground;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await channel.post("background/upload", {
      mime,
      data: b64encode(bytes),
    });
    setBackgroundImage(bytes, mime);
    state.pendingBackground = null;
    elements.bgStatus.textContent = "背景已应用。";
    toast("自定义背景已更新");
  } catch (error) {
    console.error(error);
    elements.bgStatus.textContent = error?.message || "上传失败";
    toast(error?.message || "上传背景失败", true);
  } finally {
    elements.bgApply.disabled = !state.pendingBackground;
    elements.bgReset.disabled = false;
  }
}

async function resetBackground() {
  if (!channel) return;
  elements.bgReset.disabled = true;
  elements.bgStatus.textContent = "正在恢复默认背景…";
  try {
    await channel.post("background/reset", {});
    clearBackgroundImage();
    state.pendingBackground = null;
    if (state.previewUrl) {
      URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = null;
    }
    elements.bgPreview.hidden = true;
    elements.bgPreview.removeAttribute("src");
    elements.bgApply.disabled = true;
    elements.bgStatus.textContent = "已恢复默认网格背景。";
    toast("已恢复默认背景");
  } catch (error) {
    console.error(error);
    elements.bgStatus.textContent = error?.message || "恢复失败";
    toast(error?.message || "恢复默认背景失败", true);
  } finally {
    elements.bgReset.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Settings / theme                                                   */
/* ------------------------------------------------------------------ */
function applySettings(options = {}) {
  const settings = state.settings;
  document.documentElement.style.setProperty(
    "--veil-opacity",
    String(settings.veil),
  );
  document.documentElement.style.setProperty(
    "--bg-blur",
    `${Number(settings.blur)}px`,
  );
  for (const input of document.querySelectorAll("input[data-option]")) {
    const key = input.dataset.option;
    if (key in settings) input.value = String(settings[key]);
  }
  for (const output of document.querySelectorAll("output[data-output]")) {
    const key = output.dataset.output;
    if (key in settings) {
      output.textContent =
        key === "fontSize" || key === "blur"
          ? String(Math.round(settings[key]))
          : Number(settings[key]).toFixed(2);
    }
  }
  if (options.fit !== false) {
    for (const tab of state.tabs.values()) {
      if (tab.term) tab.term.options.fontSize = settings.fontSize;
    }
    if (state.active) fitTab(state.tabs.get(state.active));
  }
  if (options.save !== false) {
    saveSettings();
    schedulePreferenceSave();
  }
}

async function loadPreferences() {
  try {
    const data = await channel.post("preferences/get", {});
    if (data.settings && Object.keys(data.settings).length) {
      state.settings = normalizeSettings({
        ...state.settings,
        ...data.settings,
      });
      applySettings({ fit: true, save: false });
      saveSettings();
    }
  } catch (error) {
    console.warn("preferences load failed", error);
  } finally {
    state.prefsLoaded = true;
  }
}

function schedulePreferenceSave() {
  if (!state.prefsLoaded || !channel) return;
  if (state.prefTimer) clearTimeout(state.prefTimer);
  state.prefTimer = setTimeout(async () => {
    state.prefTimer = null;
    try {
      await channel.post("preferences/save", {
        settings: state.settings,
      });
    } catch (error) {
      console.warn("preferences save failed", error);
    }
  }, 700);
}

function applyTheme(isDark) {
  state.theme = isDark ? "dark" : "light";
  document.documentElement.dataset.theme = state.theme;
  const theme = isDark ? DARK_XTERM_THEME : LIGHT_XTERM_THEME;
  for (const tab of state.tabs.values()) {
    if (tab.term) tab.term.options.theme = theme;
  }
}

function loadSettings() {
  let raw = {};
  try {
    raw = parseJson(localStorage.getItem(SETTINGS_KEY), {}) || {};
  } catch (error) {
    raw = {};
  }
  return normalizeSettings(raw);
}

function normalizeSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return settings;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = Number(raw[key]);
    if (Number.isFinite(value)) settings[key] = value;
  }
  settings.blur = clamp(settings.blur, 0, 40);
  settings.veil = clamp(settings.veil, 0.05, 0.85);
  settings.fontSize = Math.round(clamp(settings.fontSize, 11, 20));
  return settings;
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch (error) {
    console.warn("could not save settings", error);
  }
}

/* ------------------------------------------------------------------ */
/* UI                                                                 */
/* ------------------------------------------------------------------ */
function bindUi() {
  for (const tab of elements.viewTabs) {
    tab.addEventListener("click", () => setView(tab.dataset.view));
  }

  elements.newTab.addEventListener("click", createTerminal);
  elements.emptyNew.addEventListener("click", createTerminal);
  elements.bgBtn.addEventListener("click", () => openModal(elements.bgModal));
  elements.helpBtn.addEventListener("click", () =>
    openModal(elements.helpModal),
  );

  document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () =>
      closeModal(document.getElementById(button.dataset.close)),
    );
  });

  document.querySelectorAll(".modal").forEach((modal) => {
    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeModal(modal);
    });
  });

  elements.bgFile.addEventListener("change", () => {
    prepareBackground(elements.bgFile.files?.[0]);
  });
  elements.bgApply.addEventListener("click", applyBackground);
  elements.bgReset.addEventListener("click", resetBackground);

  elements.dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.dropzone.classList.add("dragover");
  });
  elements.dropzone.addEventListener("dragleave", () => {
    elements.dropzone.classList.remove("dragover");
  });
  elements.dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.dropzone.classList.remove("dragover");
    prepareBackground(event.dataTransfer.files?.[0]);
  });

  for (const input of document.querySelectorAll("input[data-option]")) {
    input.addEventListener("input", () => {
      const key = input.dataset.option;
      const value = Number(input.value);
      if (!(key in state.settings) || !Number.isFinite(value)) return;
      state.settings[key] = value;
      applySettings();
    });
  }

  document.addEventListener("keydown", handleGlobalKey, true);
  window.addEventListener("resize", () => {
    if (state.active) fitTab(state.tabs.get(state.active));
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      saveTabs();
      return;
    }
    if (!state.connected) {
      state.streamRetry = 0;
      connectStream(state.lastSeq);
    }
    if (state.active) fitTab(state.tabs.get(state.active));
  });
  window.addEventListener("beforeunload", () => {
    saveTabs();
    if (state.streamSub && bridge?.unsubscribeSSE) {
      try {
        Promise.resolve(bridge.unsubscribeSSE(state.streamSub)).catch(
          () => {},
        );
      } catch (error) {
        // Ignore cleanup failures during unload.
      }
    }
  });

  elements.bgModal.addEventListener("click", (event) => {
    if (event.target === elements.bgModal) closeModal(elements.bgModal);
  });
  elements.helpModal.addEventListener("click", (event) => {
    if (event.target === elements.helpModal) closeModal(elements.helpModal);
  });
}

function handleGlobalKey(event) {
  if (event.key === "Escape") {
    if (state.contextMenu) {
      closeContextMenu();
      event.preventDefault();
      return;
    }
    if (!elements.bgModal.classList.contains("hidden")) {
      closeModal(elements.bgModal);
      return;
    }
    if (!elements.helpModal.classList.contains("hidden")) {
      closeModal(elements.helpModal);
      return;
    }
  }

  if (state.view !== "terminal") return;

  const target = event.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  ) {
    return;
  }

  const modifier = event.ctrlKey || event.metaKey;
  if (!modifier) return;
  const key = event.key.toLowerCase();

  if (event.shiftKey && key === "t") {
    event.preventDefault();
    createTerminal();
    return;
  }
  if (event.shiftKey && key === "w") {
    event.preventDefault();
    if (state.active) removeTab(state.active, { notify: true });
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    cycleTab(event.shiftKey ? -1 : 1);
    return;
  }
  if (event.shiftKey && key === "c") {
    const tab = state.tabs.get(state.active);
    if (tab?.term?.hasSelection()) {
      event.preventDefault();
      event.stopPropagation();
      copyText(tab.term.getSelection());
    }
  }
}

function cycleTab(direction) {
  if (!state.order.length) return;
  const index = Math.max(0, state.order.indexOf(state.active));
  const next =
    (index + direction + state.order.length) % state.order.length;
  activateTab(state.order[next]);
}

function openModal(modal) {
  if (!modal) return;
  if (state.active) state.tabs.get(state.active)?.term?.blur();
  if (modal === elements.bgModal) {
    applySettings();
    elements.bgStatus.textContent = state.hasBackground
      ? "当前已有自定义背景。选择新图片可替换。"
      : "图片保存在 AstrBot 插件数据目录；上传与回传均走加密通道。";
    if (!state.hasBackground && !state.pendingBackground) {
      elements.bgPreview.hidden = true;
    }
  }
  modal.classList.remove("hidden");
}

function closeModal(modal) {
  if (!modal) return;
  modal.classList.add("hidden");
}

function showContextMenu(tab, x, y) {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu";

  const item = (label, handler, danger = false) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (danger) button.classList.add("danger");
    button.addEventListener("click", () => {
      closeContextMenu();
      handler();
    });
    menu.append(button);
  };

  item("复制选中", () => {
    const selection = tab.term.getSelection();
    if (selection) copyText(selection);
    else toast("没有选中文本");
  });
  item("复制全部", () => copyText(bufferText(tab)));
  item("粘贴", () => pasteTo(tab));
  item("清空屏幕", () => {
    tab.term.clear();
    tab.term.focus();
  });
  const hr = document.createElement("hr");
  menu.append(hr);
  item("关闭终端", () => removeTab(tab.sid, { notify: true }), true);

  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  state.contextMenu = menu;

  setTimeout(() => {
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!menu.contains(event.target)) closeContextMenu();
      },
      { once: true },
    );
  }, 0);
}

function closeContextMenu() {
  state.contextMenu?.remove();
  state.contextMenu = null;
}

function pasteTo(tab) {
  if (!navigator.clipboard?.readText) {
    toast("当前浏览器不允许读取剪贴板，请使用 Ctrl+V", true);
    return;
  }
  navigator.clipboard
    .readText()
    .then((text) => {
      if (text) queueInput(tab, text);
    })
    .catch(() => {
      toast("无法读取剪贴板，请使用 Ctrl+V", true);
    });
}

async function copyText(text) {
  if (!text) {
    toast("没有可复制的内容");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制到剪贴板");
  } catch (error) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (error) {
      ok = false;
    }
    textarea.remove();
    toast(ok ? "已复制到剪贴板" : "复制失败，请手动选择文本", !ok);
  }
}

function bufferText(tab) {
  try {
    const buffer = tab.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i += 1) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    while (lines.length && lines[0].trim() === "") lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
    return lines.join("\n");
  } catch (error) {
    return "";
  }
}

function updatePaneMeta(tab) {
  tab.meta.shell.textContent = basename(tab.shell || "shell");
  tab.meta.cwd.textContent = tab.cwd || "~";
  tab.meta.badge.textContent = tab.backend || "pty";
}

function updateEmptyState() {
  const empty = state.order.length === 0;
  elements.empty.classList.toggle("hidden", !empty);
  elements.terminals.classList.toggle("hidden", empty);
}

function setConnection(mode, text) {
  elements.statusDot.classList.remove("online", "offline");
  if (mode === "online") elements.statusDot.classList.add("online");
  if (mode === "offline") elements.statusDot.classList.add("offline");
  elements.statusText.textContent = text || "";
  elements.statusConnection.title = text || "";
}

function updateCryptoBadge(ok) {
  elements.cryptoBadge.classList.toggle("broken", !ok);
  const label = elements.cryptoBadge.querySelector("span");
  if (label) label.textContent = ok ? "AES-256-GCM" : "加密异常";
  if (!ok) {
    elements.statusEncryption.textContent = "加密通道异常";
  } else {
    updateEncryptionLabel();
  }
}

function updateEncryptionLabel() {
  const backend =
    channel?.backendName === "noble-p256" ? "Noble" : "WebCrypto";
  elements.statusEncryption.textContent = `ECDH P-256 · ${backend} · AES-256-GCM`;
}

function updateSessionLabel() {
  elements.statusSession.textContent = channel?.sid
    ? `sid ${channel.sid.slice(0, 10)}`
    : "";
}

function updateStatusSize() {
  const tab = state.active ? state.tabs.get(state.active) : null;
  elements.statusSize.textContent = tab?.term
    ? `${tab.term.cols}×${tab.term.rows}`
    : "";
}

function startClock() {
  const tick = () => {
    elements.statusClock.textContent = new Date().toLocaleTimeString(
      "zh-CN",
      { hour12: false },
    );
  };
  tick();
  setInterval(tick, 1000);
}

function toast(message, isError = false) {
  if (!elements.toast) return;
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", isError);
  elements.toast.classList.add("show");
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    elements.toast.classList.remove("show");
  }, 3200);
}

function showFatal(title, detail) {
  state.fatal = true;
  elements.empty.classList.remove("hidden");
  elements.terminals.classList.add("hidden");
  const heading = elements.empty.querySelector("h2");
  const paragraph = elements.empty.querySelector("p:not(.eyebrow)");
  if (heading) heading.textContent = title || "发生错误";
  if (paragraph) paragraph.textContent = detail || "";
  elements.emptyNew.textContent = "重新加载";
  elements.emptyNew.onclick = () => window.location.reload();
  setConnection("offline", title || "发生错误");
  updateCryptoBadge(false);
}

/* ------------------------------------------------------------------ */
/* Persistence / helpers                                              */
/* ------------------------------------------------------------------ */
function loadTabState() {
  try {
    const value = parseJson(sessionStorage.getItem(TABS_KEY), null);
    if (!value || !Array.isArray(value.tabs)) return null;
    return value;
  } catch (error) {
    return null;
  }
}

function saveTabs() {
  try {
    const tabs = state.order
      .map((sid) => {
        const tab = state.tabs.get(sid);
        return tab ? { sid, title: tab.title } : null;
      })
      .filter(Boolean);
    sessionStorage.setItem(
      TABS_KEY,
      JSON.stringify({ tabs, active: state.active }),
    );
  } catch (error) {
    console.warn("could not save tab state", error);
  }
}

function getOwner() {
  const prefix = "terminal-shell-owner:";
  try {
    let owner = sessionStorage.getItem(OWNER_KEY);
    if (!owner) {
      owner =
        window.crypto?.randomUUID?.() ||
        `owner_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(OWNER_KEY, owner);
    }
    return owner;
  } catch (error) {
    // Sandboxed iframes may have an opaque origin and no Web Storage.
    try {
      if (window.name?.startsWith(prefix)) {
        return window.name.slice(prefix.length);
      }
      const owner =
        window.crypto?.randomUUID?.() ||
        `owner_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      window.name = prefix + owner;
      return owner;
    } catch (inner) {
      return `owner_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }
  }
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function basename(path) {
  if (!path) return "shell";
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || "shell";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
