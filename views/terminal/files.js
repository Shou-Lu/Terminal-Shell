import { b64encode, b64decode } from "./crypto.js";

const $ = (id) => document.getElementById(id);

const state = {
  path: "",
  entries: [],
  root: "",
  maxBytes: 8 * 1024 * 1024,
  preview: null,
  textEditor: null,
  toastTimer: null,
  modalResolve: null,
  bound: false,
  channel: null,
  loaded: false,
  loading: false,
  fabOpen: false,
  rowMenuAnchor: null,
};

let rowMenu = null;

const elements = {
  fileList: $("fm-file-list"),
  empty: $("fm-empty-state"),
  breadcrumb: $("fm-breadcrumb"),
  title: $("fm-title"),
  rootLabel: $("fm-root"),
  status: $("fm-status"),
  count: $("fm-count"),
  mode: $("fm-mode"),
  cryptoBadge: $("fm-crypto-badge"),
  refresh: $("fm-refresh"),
  mkdir: $("fm-mkdir"),
  up: $("fm-up"),
  fab: $("fm-fab"),
  fabWrap: $("fm-fab-wrap"),
  fabMenu: $("fm-fab-menu"),
  upload: $("fm-upload"),
  emptyUpload: $("fm-empty-upload"),
  fileInput: $("fm-file-input"),
  modal: $("fm-modal"),
  modalTitle: $("fm-modal-title"),
  modalMessage: $("fm-modal-message"),
  modalInput: $("fm-modal-input"),
  modalCancel: $("fm-modal-cancel"),
  modalOk: $("fm-modal-ok"),
  previewModal: $("fm-preview-modal"),
  previewTitle: $("fm-preview-title"),
  previewBody: $("fm-preview-body"),
  previewClose: $("fm-preview-close"),
  previewDownload: $("fm-preview-download"),
  previewSave: $("fm-preview-save"),
  toast: $("fm-toast"),
};

let controller = null;

export function initFilesPanel(channel) {
  if (controller) return controller;
  state.channel = channel;
  bindUi();
  controller = {
    activate,
  };
  return controller;
}

async function activate() {
  if (state.loading) return;
  if (!state.loaded) {
    setStatus("正在读取目录…");
    await load("");
    state.loaded = true;
  }
}

function bindUi() {
  if (state.bound) return;
  state.bound = true;
  elements.refresh.addEventListener("click", () => load(state.path));
  elements.mkdir.addEventListener("click", () => {
    setFab(false);
    createFolder();
  });
  elements.fab.addEventListener("click", (event) => {
    event.stopPropagation();
    setFab(!state.fabOpen);
  });
  elements.upload.addEventListener("click", () => {
    setFab(false);
    elements.fileInput.click();
  });
  elements.emptyUpload.addEventListener("click", () => elements.fileInput.click());
  elements.up.addEventListener("click", () => {
    const parent = parentPath(state.path);
    if (parent !== null) load(parent);
  });
  elements.fileInput.addEventListener("change", uploadSelected);
  elements.modalCancel.addEventListener("click", () => closeModal(null));
  elements.modalOk.addEventListener("click", () => submitModal());
  elements.modalInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitModal();
    }
  });
  elements.previewClose.addEventListener("click", closePreview);
  elements.previewModal.addEventListener("click", (event) => {
    if (event.target === elements.previewModal) closePreview();
  });
  elements.modal.addEventListener("click", (event) => {
    if (event.target === elements.modal) closeModal(null);
  });
  elements.previewDownload.addEventListener("click", () => {
    if (state.preview) downloadEntry(state.preview);
  });
  elements.previewSave.addEventListener("click", savePreview);
  elements.fileList.addEventListener("scroll", closeRowMenu);
  window.addEventListener("resize", closeRowMenu);
  document.addEventListener("pointerdown", (event) => {
    if (
      state.fabOpen &&
      !elements.fabWrap.contains(event.target)
    ) {
      setFab(false);
    }
    if (
      rowMenu &&
      !rowMenu.classList.contains("hidden") &&
      !rowMenu.contains(event.target) &&
      !state.rowMenuAnchor?.contains(event.target)
    ) {
      closeRowMenu();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!elements.previewModal.classList.contains("hidden")) {
      closePreview();
    } else if (!elements.modal.classList.contains("hidden")) {
      closeModal(null);
    } else if (rowMenu && !rowMenu.classList.contains("hidden")) {
      closeRowMenu();
    } else if (state.fabOpen) {
      setFab(false);
    }
  });
  document.addEventListener("pointerdown", rippleAt);
}

async function api(action, payload) {
  try {
    return await state.channel.post(action, payload);
  } catch (error) {
    if (/加密|密文|会话|session|crypto/i.test(String(error?.message || ""))) {
      updateBadge(false);
    }
    throw error;
  }
}

async function load(path) {
  state.loading = true;
  setStatus("正在读取目录…");
  try {
    const data = await api("files/list", { path: path || "" });
    state.path = data.path || "";
    state.entries = data.entries || [];
    state.root = data.root || "";
    state.maxBytes = data.max_bytes || state.maxBytes;
    elements.rootLabel.textContent = state.root;
    elements.rootLabel.title = state.root;
    elements.title.textContent = state.path
      ? state.path.split("/").filter(Boolean).pop()
      : "文件";
    elements.title.title = state.path || "文件";
    elements.up.disabled = !state.path;
    elements.count.textContent = `${state.entries.length} 项`;
    renderBreadcrumb();
    renderEntries();
    setStatus(`已加载 ${state.entries.length} 项`);
    updateBadge(true);
  } catch (error) {
    console.error(error);
    setStatus(error?.message || "读取目录失败", true);
    toast(error?.message || "读取目录失败", true);
  } finally {
    state.loading = false;
  }
}

function renderBreadcrumb() {
  elements.breadcrumb.replaceChildren();
  const rootButton = document.createElement("button");
  rootButton.className = "fm-crumb" + (state.path ? "" : " current");
  rootButton.type = "button";
  rootButton.textContent = "根目录";
  rootButton.title = "/";
  rootButton.addEventListener("click", () => load(""));
  elements.breadcrumb.append(rootButton);

  const parts = state.path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const sep = document.createElement("span");
    sep.className = "fm-crumb-sep";
    sep.textContent = "›";
    elements.breadcrumb.append(sep);
    const button = document.createElement("button");
    button.className = "fm-crumb";
    button.type = "button";
    button.textContent = part;
    button.title = current;
    const target = current;
    button.addEventListener("click", () => load(target));
    elements.breadcrumb.append(button);
  }
  const last = elements.breadcrumb.querySelector(".fm-crumb:last-of-type");
  if (last) last.classList.add("current");
  elements.breadcrumb.scrollLeft = elements.breadcrumb.scrollWidth;
}

function renderEntries() {
  elements.fileList.replaceChildren();
  const empty = state.entries.length === 0;
  elements.empty.classList.toggle("hidden", !empty);
  elements.fileList.classList.toggle("hidden", empty);
  for (const entry of state.entries) {
    elements.fileList.append(buildRow(entry));
  }
}

function buildRow(entry) {
  const row = document.createElement("div");
  row.className = "fm-row";
  row.setAttribute("role", "listitem");

  const main = document.createElement("button");
  main.className = "fm-row-main";
  main.type = "button";
  main.title = entry.path;
  main.addEventListener("click", () => openEntry(entry));

  const kind = entry.is_dir ? "folder" : fileKind(entry.name);
  const icon = document.createElement("span");
  icon.className = "fm-file-icon";
  icon.dataset.kind = kind;
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = iconSvg(KIND_ICONS[kind] || "file");

  const text = document.createElement("span");
  text.className = "fm-text";
  const fileName = document.createElement("span");
  fileName.className = "fm-filename";
  fileName.textContent = entry.name;
  const subtitle = document.createElement("span");
  subtitle.className = "fm-sub";
  subtitle.textContent = entry.is_dir
    ? "文件夹"
    : `${formatBytes(entry.size)} · ${formatTime(entry.mtime)}`;
  text.append(fileName, subtitle);
  main.append(icon, text);

  const menu = document.createElement("button");
  menu.type = "button";
  menu.className = "fm-row-menu-btn";
  menu.setAttribute("aria-label", `更多操作：${entry.name}`);
  menu.setAttribute("aria-haspopup", "menu");
  menu.setAttribute("aria-expanded", "false");
  menu.innerHTML = iconSvg("more");
  menu.addEventListener("click", (event) => {
    event.stopPropagation();
    openRowMenu(entry, menu);
  });

  row.append(main, menu);
  return row;
}

function openEntry(entry) {
  if (entry.is_dir) load(entry.path);
  else openPreview(entry);
}

function openRowMenu(entry, anchor) {
  const menu = ensureRowMenu();
  menu.replaceChildren();
  const actions = [];
  if (!entry.is_dir) {
    actions.push(["预览", "eye", () => openPreview(entry)]);
    actions.push(["下载", "download", () => downloadEntry(entry)]);
  }
  actions.push(["重命名", "edit", () => renameEntry(entry)]);
  actions.push(["删除", "delete", () => deleteEntry(entry), true]);

  for (const [label, iconName, handler, danger] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "fm-menu-item" + (danger ? " danger" : "");
    button.setAttribute("role", "menuitem");
    button.innerHTML = iconSvg(iconName);
    const text = document.createElement("span");
    text.textContent = label;
    button.append(text);
    button.addEventListener("click", () => {
      closeRowMenu();
      handler();
    });
    menu.append(button);
  }

  closeRowMenu();
  menu.classList.remove("hidden");
  menu.style.left = "0px";
  menu.style.top = "0px";
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.max(
    10,
    Math.min(rect.right - width, window.innerWidth - width - 10),
  );
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 10) {
    top = Math.max(10, rect.top - height - 6);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  anchor.setAttribute("aria-expanded", "true");
  state.rowMenuAnchor = anchor;
}

function ensureRowMenu() {
  if (rowMenu) return rowMenu;
  rowMenu = document.createElement("div");
  rowMenu.className = "fm-menu hidden";
  rowMenu.setAttribute("role", "menu");
  document.body.append(rowMenu);
  return rowMenu;
}

function closeRowMenu() {
  if (rowMenu) rowMenu.classList.add("hidden");
  state.rowMenuAnchor?.setAttribute("aria-expanded", "false");
  state.rowMenuAnchor = null;
}

function setFab(open) {
  state.fabOpen = Boolean(open);
  elements.fab.setAttribute("aria-expanded", state.fabOpen ? "true" : "false");
  elements.fabMenu.classList.toggle("hidden", !state.fabOpen);
}

async function createFolder() {
  const name = await askText(
    "新建文件夹",
    "输入文件夹名称。",
    "",
    "新建",
  );
  if (!name) return;
  try {
    await api("files/mkdir", { path: joinPath(state.path, name) });
    toast("文件夹已创建");
    await load(state.path);
  } catch (error) {
    toast(error?.message || "创建文件夹失败", true);
  }
}

async function renameEntry(entry) {
  const name = await askText(
    "重命名",
    `将「${entry.name}」重命名为：`,
    entry.name,
    "重命名",
  );
  if (!name || name === entry.name) return;
  try {
    await api("files/rename", {
      old: entry.path,
      new: joinPath(parentPath(entry.path) || "", name),
    });
    toast("重命名成功");
    await load(state.path);
  } catch (error) {
    toast(error?.message || "重命名失败", true);
  }
}

async function deleteEntry(entry) {
  const extra = entry.is_dir ? "\n目录及其中的全部内容都会被删除。" : "";
  const ok = await askConfirm(
    "删除确认",
    `确定删除「${entry.name}」吗？${extra}`,
    "删除",
  );
  if (!ok) return;
  try {
    await api("files/delete", {
      path: entry.path,
      recursive: entry.is_dir,
    });
    toast("已删除");
    await load(state.path);
  } catch (error) {
    toast(error?.message || "删除失败", true);
  }
}

async function uploadSelected() {
  const files = Array.from(elements.fileInput.files || []);
  elements.fileInput.value = "";
  if (!files.length) return;
  for (const file of files) {
    if (file.size > state.maxBytes) {
      toast(
        `${file.name} 超过 ${Math.round(state.maxBytes / 1024 / 1024)} MB 限制`,
        true,
      );
      continue;
    }
    const target = joinPath(state.path, file.name);
    try {
      setStatus(`正在加密上传 ${file.name}…`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        await api("files/write", {
          path: target,
          data: b64encode(bytes),
          overwrite: false,
        });
      } catch (error) {
        if (!/已存在/.test(error?.message || "")) throw error;
        const ok = await askConfirm(
          "文件已存在",
          `「${file.name}」已存在，是否覆盖？`,
          "覆盖",
        );
        if (!ok) continue;
        await api("files/write", {
          path: target,
          data: b64encode(bytes),
          overwrite: true,
        });
      }
      toast(`${file.name} 上传成功`);
    } catch (error) {
      toast(error?.message || `${file.name} 上传失败`, true);
    }
  }
  await load(state.path);
}

async function downloadEntry(entry) {
  try {
    setStatus(`正在解密下载 ${entry.name}…`);
    const data = await api("files/read", { path: entry.path });
    const bytes = b64decode(data.data || "");
    const blob = new Blob([bytes], {
      type: data.mime || "application/octet-stream",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = data.name || entry.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setStatus("下载已开始");
  } catch (error) {
    toast(error?.message || "下载失败", true);
    setStatus(error?.message || "下载失败", true);
  }
}

async function openPreview(entry) {
  if (entry.is_dir) {
    load(entry.path);
    return;
  }
  try {
    setStatus(`正在读取 ${entry.name}…`);
    const data = await api("files/read", { path: entry.path });
    state.preview = data;
    state.textEditor = null;
    elements.previewTitle.textContent = data.name || entry.name;
    elements.previewBody.replaceChildren();
    elements.previewSave.classList.add("hidden");

    const mime = data.mime || "";
    const bytes = b64decode(data.data || "");
    if (mime.startsWith("image/")) {
      const blob = new Blob([bytes], { type: mime });
      const url = URL.createObjectURL(blob);
      const image = document.createElement("img");
      image.src = url;
      image.alt = data.name || entry.name;
      image.addEventListener(
        "load",
        () => setTimeout(() => URL.revokeObjectURL(url), 1000),
        { once: true },
      );
      elements.previewBody.append(image);
    } else if (isTextMime(mime) || isTextName(data.name)) {
      const textarea = document.createElement("textarea");
      textarea.value = new TextDecoder("utf-8").decode(bytes);
      textarea.spellcheck = false;
      state.textEditor = textarea;
      elements.previewBody.append(textarea);
      elements.previewSave.classList.remove("hidden");
    } else {
      const pre = document.createElement("pre");
      pre.textContent = `二进制文件（${mime || "unknown"}）。请点击下载。`;
      elements.previewBody.append(pre);
    }
    elements.previewModal.classList.remove("hidden");
    setStatus(`已打开 ${data.name || entry.name}`);
  } catch (error) {
    toast(error?.message || "读取文件失败", true);
    setStatus(error?.message || "读取文件失败", true);
  }
}

async function savePreview() {
  if (!state.preview || !state.textEditor) return;
  try {
    const bytes = new TextEncoder().encode(state.textEditor.value);
    if (bytes.length > state.maxBytes) {
      throw new Error(
        `文件超过 ${Math.round(state.maxBytes / 1024 / 1024)} MB 限制`,
      );
    }
    await api("files/write", {
      path: state.preview.path,
      data: b64encode(bytes),
      overwrite: true,
    });
    toast("文件已保存");
    closePreview();
    await load(state.path);
  } catch (error) {
    toast(error?.message || "保存失败", true);
  }
}

function closePreview() {
  elements.previewModal.classList.add("hidden");
  elements.previewBody.replaceChildren();
  state.preview = null;
  state.textEditor = null;
}

function askText(title, message, value, confirmText) {
  return new Promise((resolve) => {
    state.modalResolve = resolve;
    elements.modalTitle.textContent = title;
    elements.modalMessage.textContent = message;
    elements.modalInput.classList.remove("hidden");
    elements.modalInput.value = value || "";
    elements.modalOk.textContent = confirmText || "确定";
    elements.modal.classList.remove("hidden");
    setTimeout(() => {
      elements.modalInput.focus();
      elements.modalInput.select();
    }, 0);
  });
}

function askConfirm(title, message, confirmText) {
  elements.modalTitle.textContent = title;
  elements.modalMessage.textContent = message;
  elements.modalInput.classList.add("hidden");
  elements.modalOk.textContent = confirmText || "确定";
  elements.modal.classList.remove("hidden");
  return new Promise((resolve) => {
    state.modalResolve = resolve;
  });
}

function submitModal() {
  if (!state.modalResolve) return;
  const resolver = state.modalResolve;
  state.modalResolve = null;
  const value = elements.modalInput.classList.contains("hidden")
    ? true
    : elements.modalInput.value.trim();
  closeModal(null);
  resolver(value || null);
}

function closeModal(value) {
  elements.modal.classList.add("hidden");
  if (state.modalResolve) {
    const resolver = state.modalResolve;
    state.modalResolve = null;
    resolver(value);
  }
}

function updateBadge(ok) {
  elements.cryptoBadge.classList.toggle("broken", !ok);
  const text = elements.cryptoBadge.lastChild;
  if (text) text.textContent = ok ? "AES-256-GCM" : "加密异常";
  elements.mode.textContent = ok
    ? "ECDH P-256 · AES-256-GCM"
    : "加密通道异常";
}

function setStatus(text, error = false) {
  elements.status.textContent = text;
  elements.status.style.color = error ? "var(--danger)" : "";
}

function toast(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.classList.add("show");
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    elements.toast.classList.remove("show");
  }, 3200);
}

function joinPath(base, name) {
  return [base, name].filter(Boolean).join("/");
}

function parentPath(path) {
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTime(seconds) {
  if (!seconds) return "—";
  try {
    return new Date(seconds * 1000).toLocaleString("zh-CN", {
      hour12: false,
    });
  } catch (error) {
    return "—";
  }
}

const ICONS = {
  folder:
    "M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z",
  file:
    "M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z",
  image:
    "M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z",
  archive:
    "M20 2H4c-1.1 0-2 .9-2 2v3.01c0 .72.43 1.34 1 1.69V20c0 1.1 1.1 2 2 2h14c.9 0 2-.9 2-2V8.7c.57-.35 1-.97 1-1.69V4c0-1.1-.9-2-2-2zm-5 12H9v-2h6v2zm5-7H4V4h16v3z",
  code:
    "M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z",
  audio:
    "M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z",
  video:
    "M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z",
  pdf:
    "M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM9 9.5h1v-1H9v1zm0 2h1.5V13H9V7h2c.83 0 1.5.67 1.5 1.5v1c0 .83-.67 1.5-1.5 1.5H9zm5.5 1.5H13V7h1.5c.83 0 1.5.67 1.5 1.5v3c0 .83-.67 1.5-1.5 1.5zm4-4H17v1h1.5V11H17v2h-1.5V7h3v1.5zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6z",
  more:
    "M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z",
  eye:
    "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z",
  download:
    "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z",
  edit:
    "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
  delete:
    "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
};

const KIND_ICONS = {
  folder: "folder",
  image: "image",
  archive: "archive",
  code: "code",
  audio: "audio",
  video: "video",
  pdf: "pdf",
  file: "file",
};

const KIND_EXTENSIONS = {
  image: [
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif", "heic", "tif", "tiff",
  ],
  archive: [
    "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz", "zipx", "iso", "cab",
  ],
  code: [
    "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "html", "htm", "css", "scss",
    "less", "py", "sh", "bash", "zsh", "fish", "bat", "cmd", "ps1", "c", "h",
    "cpp", "hpp", "cc", "java", "kt", "go", "rs", "php", "rb", "sql", "yml",
    "yaml", "toml", "ini", "cfg", "conf", "md", "markdown", "txt", "log", "xml",
    "env", "gitignore", "dockerfile",
  ],
  audio: ["mp3", "wav", "flac", "ogg", "m4a", "aac", "wma", "opus", "mid"],
  video: ["mp4", "mkv", "avi", "mov", "webm", "flv", "wmv", "m4v", "mpg", "mpeg"],
  pdf: ["pdf"],
};

function iconSvg(name) {
  const path = ICONS[name] || ICONS.file;
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
}

function fileKind(name) {
  const value = String(name || "").toLowerCase();
  const ext = value.includes(".") ? value.split(".").pop() : value;
  for (const [kind, extensions] of Object.entries(KIND_EXTENSIONS)) {
    if (extensions.includes(ext)) return kind;
  }
  return "file";
}

function rippleAt(event) {
  if (event.button !== undefined && event.button !== 0) return;
  const host = event.target.closest?.(
    ".fm-crumb, .fm-row-main, .fm-row-menu-btn, .fm-fab, .fm-fab-action, .fm-iconbtn, .fm-btn, .fm-textbtn, .fm-menu-item, .fm-icon-btn",
  );
  if (!host) return;
  const rect = host.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 2;
  const ripple = document.createElement("span");
  ripple.className = "fm-ripple";
  ripple.style.width = `${size}px`;
  ripple.style.height = `${size}px`;
  ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
  ripple.style.top = `${event.clientY - rect.top - size / 2}px`;
  host.append(ripple);
  ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
}

function isTextMime(mime) {
  return (
    mime.startsWith("text/") ||
    /(?:json|javascript|xml|x-sh|yaml|csv|markdown)/i.test(mime)
  );
}

function isTextName(name) {
  return /\.(?:txt|md|markdown|json|ya?ml|toml|ini|cfg|conf|log|js|mjs|cjs|ts|tsx|jsx|css|html?|xml|py|sh|bash|zsh|fish|bat|cmd|ps1|c|h|cpp|hpp|java|go|rs|php|rb|sql|env|gitignore)$/i.test(
    name || "",
  );
}
