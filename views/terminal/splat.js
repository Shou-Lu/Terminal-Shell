/* Gaussian-splat style background renderer.
 *
 * The uploaded (or generated) image is sampled into a grid of soft,
 * additive Gaussian points. Each point drifts slowly and reacts to the
 * pointer, producing a living "splatted" scene behind the terminal.
 */

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
in vec3 a_color;
in vec3 a_meta; // seed, size factor, alpha
uniform vec2 u_res;
uniform vec2 u_cover;
uniform float u_time;
uniform float u_drift;
uniform vec2 u_mouse;
uniform float u_size;
uniform float u_dpr;
out vec3 v_color;
out float v_alpha;

void main() {
  vec2 p = (a_pos - 0.5) * u_cover + 0.5;
  float seed = a_meta.x;
  float t = u_time * 0.11;
  p += vec2(
    sin(t + seed * 6.2831),
    cos(t * 0.83 + seed * 12.566)
  ) * 0.006 * u_drift;
  p += u_mouse * (0.008 + seed * 0.006);

  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);

  float scale = u_res.y / 900.0;
  float px = 22.0 * u_size * (0.55 + a_meta.y * 0.75) * scale * u_dpr;
  gl_PointSize = clamp(px, 1.0, 80.0);
  v_color = a_color;
  v_alpha = a_meta.z;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 v_color;
in float v_alpha;
uniform float u_glow;
out vec4 outColor;

void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float g = exp(-r2 * 5.0);
  float alpha = clamp(g * v_alpha * u_glow, 0.0, 1.0);
  outColor = vec4(v_color, alpha);
}
`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${message}`);
  }
  return shader;
}

function createProgram(gl) {
  const program = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program link error: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

export class SplatBackground {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.options = {
      size: 3.2,
      glow: 1.2,
      drift: 1,
      ...options,
    };
    if (
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      this.options.drift = 0;
    }
    this.gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });
    this.points = 0;
    this.luminance = 0;
    this.imageAspect = 16 / 9;
    this.cover = [1, 1];
    this.mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    this.startTime = performance.now();
    this._raf = 0;
    this._disposed = false;

    this._onResize = this._onResize.bind(this);
    this._onPointer = this._onPointer.bind(this);
    this._render = this._render.bind(this);

    if (!this.gl) {
      canvas.style.display = "none";
      document.body.classList.add("no-webgl");
      return;
    }

    this._initGL();
    window.addEventListener("resize", this._onResize, { passive: true });
    window.addEventListener("pointermove", this._onPointer, { passive: true });
    document.addEventListener("visibilitychange", this._onResize);
    this._onResize();
    this._raf = requestAnimationFrame(this._render);
  }

  _initGL() {
    const gl = this.gl;
    this.program = createProgram(gl);
    this.locations = {
      pos: gl.getAttribLocation(this.program, "a_pos"),
      color: gl.getAttribLocation(this.program, "a_color"),
      meta: gl.getAttribLocation(this.program, "a_meta"),
      res: gl.getUniformLocation(this.program, "u_res"),
      cover: gl.getUniformLocation(this.program, "u_cover"),
      time: gl.getUniformLocation(this.program, "u_time"),
      drift: gl.getUniformLocation(this.program, "u_drift"),
      mouse: gl.getUniformLocation(this.program, "u_mouse"),
      size: gl.getUniformLocation(this.program, "u_size"),
      dpr: gl.getUniformLocation(this.program, "u_dpr"),
      glow: gl.getUniformLocation(this.program, "u_glow"),
    };

    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(this.locations.pos);
    gl.vertexAttribPointer(
      this.locations.pos,
      2,
      gl.FLOAT,
      false,
      32,
      0,
    );
    gl.enableVertexAttribArray(this.locations.color);
    gl.vertexAttribPointer(
      this.locations.color,
      3,
      gl.FLOAT,
      false,
      32,
      8,
    );
    gl.enableVertexAttribArray(this.locations.meta);
    gl.vertexAttribPointer(
      this.locations.meta,
      3,
      gl.FLOAT,
      false,
      32,
      20,
    );

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0.012, 0.018, 0.045, 1);
  }

  _onResize() {
    if (!this.gl) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(window.innerWidth * dpr));
    const height = Math.max(1, Math.round(window.innerHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.dpr = dpr;
    this.gl.viewport(0, 0, width, height);
    const screenAspect = window.innerWidth / Math.max(1, window.innerHeight);
    this.cover =
      screenAspect > this.imageAspect
        ? [screenAspect / this.imageAspect, 1]
        : [1, this.imageAspect / screenAspect];
  }

  _onPointer(event) {
    this.mouse.tx = (event.clientX / window.innerWidth - 0.5) * 2;
    this.mouse.ty = (event.clientY / window.innerHeight - 0.5) * 2;
  }

  setOptions(options) {
    Object.assign(this.options, options);
  }

  async setDefault() {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 675;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const base = ctx.createLinearGradient(0, 0, 1200, 675);
    base.addColorStop(0, "#07111f");
    base.addColorStop(0.45, "#0a1024");
    base.addColorStop(1, "#05060f");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 1200, 675);

    const blobs = [
      [240, 230, 360, "#2dd4ff", 0.42],
      [930, 170, 330, "#8b5cf6", 0.38],
      [820, 560, 380, "#ec4899", 0.25],
      [360, 600, 300, "#f59e0b", 0.18],
      [600, 330, 420, "#22d3ee", 0.13],
    ];
    ctx.globalCompositeOperation = "lighter";
    for (const [x, y, radius, color, alpha] of blobs) {
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, this._rgba(color, alpha));
      gradient.addColorStop(0.45, this._rgba(color, alpha * 0.35));
      gradient.addColorStop(1, this._rgba(color, 0));
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 1200, 675);
    }

    for (let i = 0; i < 190; i += 1) {
      const x = Math.random() * 1200;
      const y = Math.random() * 675;
      const radius = 1 + Math.random() * 2.6;
      const tint = Math.random() > 0.5 ? "#9be8ff" : "#c4b5fd";
      ctx.fillStyle = this._rgba(tint, 0.25 + Math.random() * 0.5);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = "source-over";
    await this.setImage(canvas, 1200, 675);
  }

  _rgba(hex, alpha) {
    const value = hex.replace("#", "");
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  async setBytes(bytes, mime = "image/jpeg") {
    const blob = new Blob([bytes], { type: mime });
    return this.setBlob(blob);
  }

  async setBlob(blob) {
    if ("createImageBitmap" in window) {
      try {
        const bitmap = await createImageBitmap(blob);
        await this.setImage(bitmap, bitmap.width, bitmap.height);
        bitmap.close?.();
        return;
      } catch (error) {
        // Fall through to an <img> element for exotic formats.
      }
    }
    const url = URL.createObjectURL(blob);
    try {
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("图片解码失败"));
        img.src = url;
      });
      await this.setImage(image, image.naturalWidth, image.naturalHeight);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async setImage(source, width, height) {
    if (!this.gl) return;
    const imageAspect = width / Math.max(1, height);
    this.imageAspect = imageAspect;

    const gridWidth = Math.min(
      190,
      Math.max(84, Math.round(window.innerWidth / 8)),
    );
    const gridHeight = Math.max(
      36,
      Math.min(160, Math.round(gridWidth / imageAspect)),
    );
    const off = document.createElement("canvas");
    off.width = gridWidth;
    off.height = gridHeight;
    const ctx = off.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(source, 0, 0, gridWidth, gridHeight);
    const pixels = ctx.getImageData(0, 0, gridWidth, gridHeight).data;

    let luminanceSum = 0;
    let luminanceWeight = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const alpha = pixels[index + 3] / 255;
      if (alpha < 0.03) continue;
      const luminance =
        (0.2126 * pixels[index] +
          0.7152 * pixels[index + 1] +
          0.0722 * pixels[index + 2]) /
        255;
      luminanceSum += luminance * alpha;
      luminanceWeight += alpha;
    }
    this.luminance = luminanceWeight
      ? luminanceSum / luminanceWeight
      : 0;

    const values = [];
    const pushPoint = (x, y, r, g, b, alpha, size, seed) => {
      values.push(
        x,
        y,
        r / 255,
        g / 255,
        b / 255,
        seed,
        size,
        alpha,
      );
    };

    for (let y = 0; y < gridHeight; y += 1) {
      for (let x = 0; x < gridWidth; x += 1) {
        const index = (y * gridWidth + x) * 4;
        const alpha = pixels[index + 3] / 255;
        if (alpha < 0.06) continue;
        const r = pixels[index];
        const g = pixels[index + 1];
        const b = pixels[index + 2];
        const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        if (luminance < 0.012 && Math.random() < 0.6) continue;
        const seed = Math.random();
        const pointAlpha =
          alpha * (0.1 + Math.min(0.78, luminance * 1.15 + 0.08));
        pushPoint(
          (x + Math.random() * 0.6) / (gridWidth - 1),
          (y + Math.random() * 0.6) / (gridHeight - 1),
          Math.min(255, r * 1.18 + 8),
          Math.min(255, g * 1.18 + 8),
          Math.min(255, b * 1.2 + 10),
          pointAlpha,
          0.55 + Math.random() * 0.9 + luminance * 0.35,
          seed,
        );
      }
    }

    const bloomCount = Math.round((gridWidth * gridHeight) / 14);
    for (let i = 0; i < bloomCount; i += 1) {
      const x = Math.floor(Math.random() * gridWidth);
      const y = Math.floor(Math.random() * gridHeight);
      const index = (y * gridWidth + x) * 4;
      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];
      const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      pushPoint(
        (x + Math.random() * 2 - 1) / (gridWidth - 1),
        (y + Math.random() * 2 - 1) / (gridHeight - 1),
        Math.min(255, r * 1.25 + 12),
        Math.min(255, g * 1.25 + 12),
        Math.min(255, b * 1.25 + 14),
        0.07 + luminance * 0.26,
        1.45 + Math.random() * 1.5,
        Math.random(),
      );
    }

    this.points = values.length / 8;
    const data = new Float32Array(values);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this._onResize();
  }

  _render(now) {
    if (this._disposed) return;
    this._raf = requestAnimationFrame(this._render);
    if (!this.gl || !this.points) return;
    if (document.hidden) return;

    const gl = this.gl;
    const time = (now - this.startTime) / 1000;
    this.mouse.x += (this.mouse.tx - this.mouse.x) * 0.045;
    this.mouse.y += (this.mouse.ty - this.mouse.y) * 0.045;

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);

    gl.uniform2f(
      this.locations.res,
      window.innerWidth,
      window.innerHeight,
    );
    gl.uniform2f(this.locations.cover, this.cover[0], this.cover[1]);
    gl.uniform1f(this.locations.time, time);
    gl.uniform1f(this.locations.drift, this.options.drift);
    gl.uniform2f(this.locations.mouse, this.mouse.x, this.mouse.y);
    gl.uniform1f(this.locations.size, this.options.size);
    gl.uniform1f(this.locations.dpr, this.dpr || 1);
    gl.uniform1f(this.locations.glow, this.options.glow);

    gl.drawArrays(gl.POINTS, 0, this.points);
  }

  destroy() {
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("pointermove", this._onPointer);
    document.removeEventListener("visibilitychange", this._onResize);
    if (this.gl) {
      this.gl.deleteBuffer(this.buffer);
      this.gl.deleteProgram(this.program);
    }
  }
}
