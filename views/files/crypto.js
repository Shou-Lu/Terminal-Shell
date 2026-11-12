/* Application-layer encryption for Terminal Shell.
 *
 * Handshake: ephemeral ECDH P-256 -> HKDF-SHA256 -> AES-256-GCM.
 * Every request/response/SSE frame is an authenticated envelope. The AES-GCM
 * additional data binds the ciphertext to "<sid>|<action>", so a frame cannot
 * be replayed against a different endpoint.
 *
 * WebCrypto is used on HTTPS / localhost. On plain HTTP (where crypto.subtle
 * is unavailable) the bundled @noble/curves, @noble/hashes and @noble/ciphers
 * modules provide the same protocol.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HKDF_INFO = encoder.encode("astrbot-terminal-shell/v1");

export function b64encode(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + chunk, bytes.length)),
    );
  }
  return btoa(binary);
}

export function b64decode(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function utf8(text) {
  return encoder.encode(text);
}

export function utf8decode(bytes) {
  return decoder.decode(bytes);
}

export class SecureChannel {
  constructor(bridge) {
    this.bridge = bridge;
    this.sid = null;
    this.key = null;
    this.mode = null;
    this.privateKey = null;
    this._noble = null;
    this._pending = null;
    this._retry = 0;
    this.limits = null;
  }

  get readyState() {
    return Boolean(this.key && this.sid);
  }

  get backendName() {
    return this.mode === "noble" ? "noble-p256" : "webcrypto-p256";
  }

  async ready() {
    if (this.key) return;
    if (!this._pending) {
      this._pending = this._handshake()
        .catch((error) => {
          this.key = null;
          this.sid = null;
          throw error;
        })
        .finally(() => {
          this._pending = null;
        });
    }
    return this._pending;
  }

  async _nobleModules() {
    if (this._noble) return this._noble;
    const [curve, hkdfModule, shaModule, aesModule] = await Promise.all([
      import("./vendor/noble/p256.js"),
      import("./vendor/noble/hkdf.js"),
      import("./vendor/noble/sha256.js"),
      import("./vendor/noble/aes.js"),
    ]);
    this._noble = {
      p256: curve.p256 || curve.secp256r1,
      hkdf: hkdfModule.hkdf,
      sha256: shaModule.sha256,
      gcm: aesModule.gcm,
    };
    return this._noble;
  }

  async _handshake() {
    const hasWebCrypto = Boolean(window.crypto?.subtle);
    let result;
    let publicRaw;

    if (hasWebCrypto) {
      const pair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      );
      publicRaw = new Uint8Array(
        await crypto.subtle.exportKey("raw", pair.publicKey),
      );
      result = await this.bridge.apiPost("handshake", {
        pub: b64encode(publicRaw),
        label: "terminal-shell-webcrypto",
      });
      if (!result?.sid || !result.pub || !result.salt) {
        throw new Error("加密握手响应不完整");
      }

      const serverKey = await crypto.subtle.importKey(
        "raw",
        b64decode(result.pub),
        { name: "ECDH", namedCurve: "P-256" },
        false,
        [],
      );
      const shared = await crypto.subtle.deriveBits(
        { name: "ECDH", public: serverKey },
        pair.privateKey,
        256,
      );
      const hkdfKey = await crypto.subtle.importKey(
        "raw",
        shared,
        "HKDF",
        false,
        ["deriveKey"],
      );
      this.key = await crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: b64decode(result.salt),
          info: HKDF_INFO,
        },
        hkdfKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      this.privateKey = pair.privateKey;
      this.mode = "webcrypto";
    } else {
      const noble = await this._nobleModules();
      const privateKey = noble.p256.utils.randomPrivateKey();
      publicRaw = noble.p256.getPublicKey(privateKey, false);
      result = await this.bridge.apiPost("handshake", {
        pub: b64encode(publicRaw),
        label: "terminal-shell-noble",
      });
      if (!result?.sid || !result.pub || !result.salt) {
        throw new Error("加密握手响应不完整");
      }
      const sharedPoint = noble.p256.getSharedSecret(
        privateKey,
        b64decode(result.pub),
        false,
      );
      const shared = sharedPoint.slice(1, 33);
      this.key = noble.hkdf(
        noble.sha256,
        shared,
        b64decode(result.salt),
        HKDF_INFO,
        32,
      );
      this.privateKey = privateKey;
      this.mode = "noble";
    }

    this.sid = result.sid;
    this.ttl = result.ttl || 3600;
    this.limits = result.limits || null;
  }

  async encrypt(action, payload) {
    await this.ready();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(JSON.stringify(payload ?? {}));
    const aad = encoder.encode(`${this.sid}|${action}`);
    let ciphertext;
    if (this.mode === "webcrypto") {
      ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
          this.key,
          plaintext,
        ),
      );
    } else {
      ciphertext = this._noble.gcm(this.key, iv, aad).encrypt(plaintext);
    }
    return {
      sid: this.sid,
      a: action,
      iv: b64encode(iv),
      ct: b64encode(ciphertext),
    };
  }

  async decrypt(action, envelope) {
    await this.ready();
    if (!envelope || envelope.a !== action || envelope.sid !== this.sid) {
      throw new Error("收到不匹配的加密数据");
    }
    const iv = b64decode(envelope.iv);
    const ciphertext = b64decode(envelope.ct);
    const aad = encoder.encode(`${this.sid}|${action}`);
    let plaintext;
    if (this.mode === "webcrypto") {
      plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
        this.key,
        ciphertext,
      );
    } else {
      plaintext = this._noble.gcm(this.key, iv, aad).decrypt(ciphertext);
    }
    return JSON.parse(decoder.decode(plaintext));
  }

  async post(action, payload) {
    await this.ready();
    try {
      const envelope = await this.encrypt(action, payload);
      const response = await this.bridge.apiPost(action, envelope);
      return await this.decrypt(action, response);
    } catch (error) {
      if (this._retry < 1 && this._isSessionError(error)) {
        this._retry += 1;
        await this.reset();
        try {
          return await this.post(action, payload);
        } finally {
          this._retry = 0;
        }
      }
      throw error;
    }
  }

  _isSessionError(error) {
    const message = String(error?.message || "");
    return /会话|密文|加密|session|crypto|operation/i.test(message);
  }

  async reset() {
    this.sid = null;
    this.key = null;
    this.mode = null;
    this.privateKey = null;
    this._pending = null;
  }

  async encryptEvent(event) {
    return this.encrypt("stream", event);
  }

  async decryptEvent(envelope) {
    return this.decrypt("stream", envelope);
  }
}
