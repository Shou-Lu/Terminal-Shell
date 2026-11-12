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
};

const elements = {
  fileList: $("fm-file-list"),
  empty: $("fm-empty-state"),
  breadcrumb: $("fm-breadcrumb"),
  rootLabel: $("fm-root"),
  status: $("fm-status"),
  mode: $("fm-mode"),
  cryptoBadge: $("fm-crypto-badge"),
  refresh: $("fm-refresh"),
  mkdir: $("fm-mkdir"),
  up: $("fm-up"),
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
  elements.mkdir.addEventListener("click", createFolder);
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
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!elements.previewModal.classList.contains("hidden")) {
      closePreview();
    } else if (!elements.modal.classList.contains("hidden")) {
      closeModal(null);
    }
  });
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
    renderBreadcrumb();
    renderEntries();
    setStatus(`共 ${state.entries.length} 项 · ${state.path || "/"}`);
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
  rootButton.textContent = "/";
  rootButton.addEventListener("click", () => load(""));
  elements.breadcrumb.append(rootButton);

  const parts = state.path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const sep = document.createElement("span");
    sep.className = "fm-crumb-sep";
    sep.textContent = "/";
    elements.breadcrumb.append(sep);
    const button = document.createElement("button");
    button.className = "fm-crumb";
    button.type = "button";
    button.textContent = part;
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

  const name = document.createElement("button");
  name.className = "fm-name";
  name.type = "button";
  name.title = entry.path;

  const icon = document.createElement("span");
  icon.className = "fm-file-icon" + (entry.is_dir ? " dir" : "");
  icon.textContent = entry.is_dir ? "DIR" : fileBadge(entry.name);

  const fileName = document.createElement("span");
  fileName.className = "fm-filename";
  fileName.textContent = entry.name;
  name.append(icon, fileName);
  name.addEventListener("click", () => {
    if (entry.is_dir) load(entry.path);
    else openPreview(entry);
  });

  const size = document.createElement("span");
  size.className = "fm-meta";
  size.textContent = entry.is_dir ? "—" : formatBytes(entry.size);

  const mtime = document.createElement("span");
  mtime.className = "fm-meta";
  mtime.textContent = formatTime(entry.mtime);

  const actions = document.createElement("div");
  actions.className = "fm-row-actions";

  if (!entry.is_dir) {
    actions.append(
      miniButton("下载", () => downloadEntry(entry)),
      miniButton("预览", () => openPreview(entry)),
    );
  }
  actions.append(
    miniButton("重命名", () => renameEntry(entry)),
    miniButton("删除", () => deleteEntry(entry), true),
  );

  row.append(name, size, mtime, actions);
  return row;
}

function miniButton(label, handler, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "fm-mini" + (danger ? " danger" : "");
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
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

function fileBadge(name) {
  if (!name || name.startsWith(".")) return "FILE";
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (!ext || ext === name.toLowerCase()) return "FILE";
  return ext.slice(0, 4).toUpperCase();
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
