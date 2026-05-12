// ── Constants ─────────────────────────────────────────────────────────────

// D12 thermal label printer BLE UUIDs (AY protocol)
const PRINTER_BLE = {
  serviceUuid: "0000ff00-0000-1000-8000-00805f9b34fb",
  writeUuid:   "0000ff02-0000-1000-8000-00805f9b34fb",
  notifyUuid:  "0000ff03-0000-1000-8000-00805f9b34fb",
};

// Label canvas: landscape orientation (40 mm wide × 12 mm tall at 203 DPI).
// The bitmap sent to the printer is rotated 90° CW → 96 dots wide × 320 dots tall.
const LABEL_W = 320;  // canvas width  (40 mm @ 203 DPI)
const LABEL_H = 96;   // canvas height (12 mm @ 203 DPI)

// Web Bluetooth writeValueWithoutResponse is capped at 512 bytes by the browser.
const MAX_CHUNK_SIZE         = 512;
const CHUNK_DELAY_MS         = 5;
const CHUNK_DELAY_FALLBACK_MS = 10;
const FALLBACK_RETRY_DELAY_MS = 120;

// AY/ESC binary command bytes
const CMD_ENABLE       = [0x10, 0xFF, 0xFE, 0x01];
const CMD_WAKEUP       = new Array(12).fill(0x00);
const CMD_LOCATION_CTR = [0x1B, 0x61, 0x01];
const CMD_LINE_DOT     = [0x1B, 0x4A, 0x0A];
const CMD_POSITION     = [0x1D, 0x0C];
const CMD_STOP         = [0x10, 0xFF, 0xFE, 0x45];
const CMD_BATTERY      = [0x10, 0xFF, 0x50, 0xF1];
const CMD_VERSION      = [0x10, 0xFF, 0x20, 0xF1];

// ── State ─────────────────────────────────────────────────────────────────

const state = {
  ble: {
    supported:  typeof navigator !== "undefined" && "bluetooth" in navigator,
    device:     null,
    writeChar:  null,
    notifyChar: null,
    connected:  false,
  },
  image: {
    element:  null,    // HTMLImageElement after load
    naturalW: 0,
    naturalH: 0,
    drawW:    0,       // width drawn on label canvas (dots)
    x:        0,      // top-left position on label canvas (dots)
    y:        0,
    fileName: "",
  },
  text: {
    content:      "",
    fontFamily:   "Impact",
    fontSize:     48,
    fillColor:    "#ffffff",
    outlineColor: "#000000",
    outlineWidth: 8,
    x:            0,
    y:            0,
  },
  settings: {
    dithering:  "atkinson",
    bgColor:    "#ffffff",
    invert:     false,
    brightness: 0,
    contrast:   0,
    density:    3,
  },
  print: {
    bitmap:      null,
    printWidth:  LABEL_H,   // after 90° CW rotation: 96
    printHeight: LABEL_W,   // after 90° CW rotation: 320
  },
  status: {
    printing: false,
  },
};

const ui = {};

// ── BLE ───────────────────────────────────────────────────────────────────

function setStatus(msg) {
  if (ui.connectStatus) ui.connectStatus.textContent = msg;
}

function handleDisconnect() {
  state.ble.device     = null;
  state.ble.writeChar  = null;
  state.ble.notifyChar = null;
  state.ble.connected  = false;
  state.status.printing = false;
  if (ui.printerInfo) ui.printerInfo.textContent = "";
  setStatus("Disconnected.");
  updateUI();
}

// Known D12-family printer name prefixes.
// These devices often don't advertise their service UUID, so we combine
// name-prefix filters with acceptAllDevices as a fallback via optionalServices.
const D12_NAME_PREFIXES = ["D11", "D110", "D30", "B21", "B3S", "GT01", "GT-01", "GB02", "YBB"];

async function connectPrinter() {
  if (!state.ble.supported) throw new Error("Web Bluetooth is not available.");
  // Use acceptAllDevices + optionalServices so the device appears in the picker
  // even when it doesn't advertise the service UUID in its advertisement packets
  // (which is common for D12-family printers).
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: [PRINTER_BLE.serviceUuid],
  });
  device.addEventListener("gattserverdisconnected", handleDisconnect);
  const server     = await device.gatt.connect();
  const service    = await server.getPrimaryService(PRINTER_BLE.serviceUuid);
  const writeChar  = await service.getCharacteristic(PRINTER_BLE.writeUuid);
  const notifyChar = await service.getCharacteristic(PRINTER_BLE.notifyUuid);
  await notifyChar.startNotifications();
  state.ble.device     = device;
  state.ble.writeChar  = writeChar;
  state.ble.notifyChar = notifyChar;
  state.ble.connected  = true;
  updateUI();
  setStatus(`Connected to ${device.name || "printer"}.`);
  fetchPrinterInfo();
}

async function disconnectPrinter() {
  if (state.ble.device?.gatt?.connected) state.ble.device.gatt.disconnect();
  handleDisconnect();
}

async function queryPrinter(cmdBytes, responseTimeoutMs = 600) {
  if (!state.ble.writeChar || !state.ble.notifyChar) return null;
  const chunks  = [];
  const handler = (e) => chunks.push(new Uint8Array(e.target.value.buffer));
  state.ble.notifyChar.addEventListener("characteristicvaluechanged", handler);
  await writeBytes(cmdBytes);
  await new Promise((r) => setTimeout(r, responseTimeoutMs));
  state.ble.notifyChar.removeEventListener("characteristicvaluechanged", handler);
  const total  = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { result.set(c, off); off += c.length; }
  return result;
}

async function writeBytes(bytes) {
  if (!state.ble.writeChar) throw new Error("Not connected.");
  const data = new Uint8Array(bytes);
  if (typeof state.ble.writeChar.writeValueWithoutResponse === "function") {
    await state.ble.writeChar.writeValueWithoutResponse(data);
  } else {
    await state.ble.writeChar.writeValue(data);
  }
}

async function writePrintPayloadWithChunkSize(payload, chunkSize, chunkDelayMs) {
  for (let off = 0; off < payload.length; off += chunkSize) {
    const chunk = payload.slice(off, off + chunkSize);
    try {
      await writeBytes(chunk);
    } catch (_err) {
      // One retry for transient BLE queue overrun errors.
      await new Promise((r) => setTimeout(r, chunkDelayMs * 2));
      try {
        await writeBytes(chunk);
      } catch (retryErr) {
        throw new Error(`Chunk write failed twice at offset ${off} (${chunkSize}B): ${retryErr.message}`);
      }
    }
    if (off + chunkSize < payload.length) {
      await new Promise((r) => setTimeout(r, chunkDelayMs));
    }
  }
}

async function writePrintPayload(payload) {
  const chunkSizes = [MAX_CHUNK_SIZE, 256, 128, 64];
  let lastErr = null;

  for (let i = 0; i < chunkSizes.length; i++) {
    const chunkSize = chunkSizes[i];
    const delayMs = i === 0 ? CHUNK_DELAY_MS : CHUNK_DELAY_FALLBACK_MS;
    try {
      setStatus(`Sending print job… (${chunkSize}B chunks)`);
      await writePrintPayloadWithChunkSize(payload, chunkSize, delayMs);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, FALLBACK_RETRY_DELAY_MS));
    }
  }

  throw lastErr;
}

async function fetchPrinterInfo() {
  try {
    const bat   = await queryPrinter(CMD_BATTERY);
    const ver   = await queryPrinter(CMD_VERSION);
    const parts = [];
    if (bat && bat.length >= 2) {
      // The AY response may echo the 4-byte command header before the data.
      // Try the documented 2-byte format [charging_flag, level%] first, then
      // fall back to the echoed-command format (header + [charging_flag, level%]).
      let chargingFlag, battLevel;
      const validFlag = (b) => b === 0x00 || b === 0x02;
      if (bat[1] <= 100 && validFlag(bat[0])) {
        // Documented format: first byte is charging flag, second is level %.
        chargingFlag = bat[0];
        battLevel    = bat[1];
      } else if (bat.length >= 6 && bat[5] <= 100 && validFlag(bat[4])) {
        // Echo-prefixed format: 4-byte command echo followed by [flag, level%].
        chargingFlag = bat[4];
        battLevel    = bat[5];
      } else {
        // Unknown format — clamp whatever we have and show it.
        chargingFlag = bat[0];
        battLevel    = Math.min(100, bat[1]);
      }
      parts.push(`Battery: ${battLevel}%${chargingFlag === 0x02 ? " ⚡" : ""}`);
    }
    if (ver && ver.length > 0) {
      // Filter to printable ASCII only (same as Python's decode("ascii", errors="ignore")).
      const text = Array.from(ver)
        .filter(b => b >= 0x20 && b < 0x7F)
        .map(b => String.fromCharCode(b))
        .join("")
        .trim();
      if (text) parts.push(`FW: ${text}`);
    }
    if (ui.printerInfo && parts.length) ui.printerInfo.textContent = parts.join(" · ");
  } catch { /* best-effort */ }
}

// ── Image loading ─────────────────────────────────────────────────────────

async function loadImage(file) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.src = url;
  await img.decode();
  URL.revokeObjectURL(url);

  state.image.element  = img;
  state.image.naturalW = img.naturalWidth;
  state.image.naturalH = img.naturalHeight;
  state.image.fileName = file.name;

  // Default: fit image width to label width; center vertically if it fits.
  state.image.drawW = LABEL_W;
  const drawH = (LABEL_W / img.naturalWidth) * img.naturalHeight;
  state.image.x = 0;
  state.image.y = drawH <= LABEL_H ? Math.round((LABEL_H - drawH) / 2) : 0;

  syncImageSliders();
  reprocessImage();
}

function syncImageSliders() {
  if (!ui.imgWRange) return;
  ui.imgWRange.value       = state.image.drawW;
  ui.imgWValue.textContent = `${state.image.drawW}px`;
  ui.imgXRange.value       = state.image.x;
  ui.imgXValue.textContent = state.image.x;
  ui.imgYRange.value       = state.image.y;
  ui.imgYValue.textContent = state.image.y;
}

// ── Image processing ──────────────────────────────────────────────────────

// Apply Photoshop-style brightness (+/- shift) and contrast (midpoint scaling).
function applyBrightnessContrast(gray, brightness, contrast) {
  const brightnessShift = brightness * 2.55;
  // Photoshop contrast formula: factor = (259*(c+255)) / (255*(259-c))
  const contrastScaled = contrast * 2.55;
  const factor = (259 * (contrastScaled + 255)) / (255 * (259 - contrastScaled));
  return new Float32Array(gray.map((v) => {
    const val = factor * ((v + brightnessShift) - 128) + 128;
    return Math.max(0, Math.min(255, val));
  }));
}

// Atkinson dithering — distributes 6/8 of quantization error to 6 neighbors (1/8 each).
// The remaining 1/4 is discarded, giving crisper highlights than Floyd-Steinberg.
//
// Error kernel (relative to current pixel X):
//   . X 1 1
//   1 1 1 .
//   . 1 . .
function atkinsonDither(gray, width, height) {
  const buf = Float32Array.from(gray);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx  = y * width + x;
      const old  = Math.max(0, Math.min(255, buf[idx]));
      const next = old < 128 ? 0 : 255;
      buf[idx]   = next;
      const err  = (old - next) / 8;

      if (x + 1 < width)         buf[idx + 1]           += err;
      if (x + 2 < width)         buf[idx + 2]           += err;
      if (y + 1 < height) {
        if (x > 0)               buf[idx + width - 1]   += err;
                                 buf[idx + width]        += err;
        if (x + 1 < width)       buf[idx + width + 1]   += err;
      }
      if (y + 2 < height)        buf[idx + 2 * width]   += err;
    }
  }
  return new Uint8Array(buf.map((v) => (v < 128 ? 0 : 255)));
}

function applyThreshold(gray) {
  return new Uint8Array(gray.map((v) => (v < 128 ? 0 : 255)));
}

// Pack 0/255 pixel array into 1-bit-per-pixel (MSB = leftmost pixel).
function packBitmap(pixels, width, height) {
  const bpr    = Math.ceil(width / 8);
  const bitmap = new Uint8Array(bpr * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x] === 0) {
        bitmap[y * bpr + Math.floor(x / 8)] |= 1 << (7 - (x % 8));
      }
    }
  }
  return bitmap;
}

// Rotate a 0/255 pixel array 90° clockwise.
// Input: width × height → Output: height wide × width tall.
//
// 90° CW rotation: output pixel (ox, oy) comes from input pixel (oy, height−1−ox)
// where ox ∈ [0, height−1] and oy ∈ [0, width−1].
function rotate90CW(pixels, width, height) {
  const out = new Uint8Array(width * height);
  for (let oy = 0; oy < width; oy++) {
    for (let ox = 0; ox < height; ox++) {
      out[oy * height + ox] = pixels[(height - 1 - ox) * width + oy];
    }
  }
  return out;  // output dimensions: height wide × width tall
}

// Composite the label onto an off-screen LABEL_W × LABEL_H canvas.
function compositeLabel() {
  const canvas  = document.createElement("canvas");
  canvas.width  = LABEL_W;
  canvas.height = LABEL_H;
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = state.settings.bgColor;
  ctx.fillRect(0, 0, LABEL_W, LABEL_H);

  // Image
  if (state.image.element) {
    const drawH = (state.image.drawW / state.image.naturalW) * state.image.naturalH;
    ctx.drawImage(
      state.image.element,
      Math.round(state.image.x),
      Math.round(state.image.y),
      Math.round(state.image.drawW),
      Math.round(drawH),
    );
  }

  // Meme-style outlined text
  if (state.text.content) {
    ctx.font         = `bold ${state.text.fontSize}px "${state.text.fontFamily}"`;
    ctx.textBaseline = "top";
    ctx.lineJoin     = "round";

    if (state.text.outlineWidth > 0) {
      ctx.strokeStyle = state.text.outlineColor;
      ctx.lineWidth   = state.text.outlineWidth * 2;  // doubled: centered stroke puts half inside, half outside the glyph edge
      ctx.strokeText(state.text.content, state.text.x, state.text.y);
    }

    ctx.fillStyle = state.text.fillColor;
    ctx.fillText(state.text.content, state.text.x, state.text.y);
  }

  return canvas;
}

// Full pipeline: composite → grayscale → brightness/contrast → invert → dither
//               → rotate 90° CW → pack bitmap → update preview.
function reprocessImage() {
  const label = compositeLabel();
  const ctx   = label.getContext("2d");
  const px    = ctx.getImageData(0, 0, LABEL_W, LABEL_H).data;

  // Convert RGBA to grayscale (ITU-R BT.601 luma coefficients).
  let gray = new Float32Array(LABEL_W * LABEL_H);
  for (let i = 0; i < LABEL_W * LABEL_H; i++) {
    gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  }

  gray = applyBrightnessContrast(gray, state.settings.brightness, state.settings.contrast);

  if (state.settings.invert) {
    for (let i = 0; i < gray.length; i++) gray[i] = 255 - gray[i];
  }

  const dithered = state.settings.dithering === "atkinson"
    ? atkinsonDither(gray, LABEL_W, LABEL_H)
    : applyThreshold(gray);

  drawPreview(dithered);

  // Rotate 90° CW for the printer: output is LABEL_H (96) wide × LABEL_W (320) tall.
  const rotated = rotate90CW(dithered, LABEL_W, LABEL_H);
  state.print.bitmap      = packBitmap(rotated, LABEL_H, LABEL_W);
  state.print.printWidth  = LABEL_H;  // 96
  state.print.printHeight = LABEL_W;  // 320

  updateUI();
}

function drawPreview(dithered) {
  if (!ui.previewCanvas) return;
  const canvas  = ui.previewCanvas;
  canvas.width  = LABEL_W;
  canvas.height = LABEL_H;
  const ctx     = canvas.getContext("2d");
  const imgData = ctx.createImageData(LABEL_W, LABEL_H);
  for (let i = 0; i < LABEL_W * LABEL_H; i++) {
    const v = dithered[i];
    imgData.data[i * 4]     = v;
    imgData.data[i * 4 + 1] = v;
    imgData.data[i * 4 + 2] = v;
    imgData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);

  const bytes = Math.ceil(LABEL_H / 8) * LABEL_W;
  if (ui.previewStatus) {
    ui.previewStatus.textContent =
      `${LABEL_W}×${LABEL_H} px → printed as ${LABEL_H}×${LABEL_W} · ${bytes} bytes`;
  }
}

// ── Print payload ─────────────────────────────────────────────────────────

function buildPrintPayload(bitmap, width, height, density) {
  const clamped     = Math.max(1, Math.min(15, Math.round(density)));
  const bytesPerRow = Math.ceil(width / 8);

  const parts = [
    new Uint8Array(CMD_ENABLE),
    new Uint8Array(CMD_WAKEUP),
    new Uint8Array(CMD_LOCATION_CTR),
    new Uint8Array([0x10, 0xFF, 0x10, 0x00, clamped]),
    new Uint8Array([0x10, 0xFF, 0x10, 0x03, 0x00]),
    // GS v 0: uncompressed image; dimensions are little-endian
    new Uint8Array([
      0x1D, 0x76, 0x30, 0x00,
      bytesPerRow & 0xFF, (bytesPerRow >> 8) & 0xFF,
      height & 0xFF,      (height >> 8) & 0xFF,
    ]),
    bitmap,
    new Uint8Array(CMD_LINE_DOT),
    new Uint8Array(CMD_POSITION),
    new Uint8Array(CMD_STOP),
  ];

  const total   = parts.reduce((s, p) => s + p.length, 0);
  const payload = new Uint8Array(total);
  let offset    = 0;
  for (const p of parts) { payload.set(p, offset); offset += p.length; }
  return payload;
}

// ── UI ────────────────────────────────────────────────────────────────────

function updateUI() {
  const connected = state.ble.connected;
  const hasBitmap = !!state.print.bitmap;

  if (ui.connectBtn) {
    ui.connectBtn.textContent = connected ? "Disconnect" : "Connect";
    ui.connectBtn.className   = connected ? "secondary"  : "primary";
    ui.connectBtn.disabled    = !state.ble.supported;
  }

  if (!state.ble.supported && ui.connectStatus) {
    ui.connectStatus.textContent = "Web Bluetooth not available.";
  }

  if (ui.printBtn) {
    ui.printBtn.disabled = !connected || !hasBitmap || state.status.printing;
  }
}

function renderApp(root) {
  root.innerHTML = `
    <main class="layout">

      <!-- Printer status bar -->
      <section class="card compact-card">
        <div class="dp-row">
          <button id="connect-btn" class="primary" type="button">Connect</button>
          <span id="connect-status" class="status" style="flex:1;margin:0;">Not connected.</span>
          <span id="printer-info" class="meta" style="margin:0;"></span>
        </div>
      </section>

      <!-- Controls -->
      <section class="card">

        <!-- Dithering + background + invert -->
        <div class="dp-row">
          <select id="dither-select" style="flex:1;">
            <option value="atkinson">Atkinson</option>
            <option value="threshold">Threshold</option>
          </select>
          <label class="dp-row" style="margin:0;gap:0.3rem;" title="Background colour">
            BG<input id="bg-color" type="color" value="#ffffff" class="dp-color" />
          </label>
          <label class="dp-row" style="margin:0;gap:0.3rem;">
            <input id="invert-input" type="checkbox" />Invert
          </label>
        </div>

        <!-- Image -->
        <div class="dp-section">
          <div class="dp-row">
            <button id="upload-btn" type="button" style="white-space:nowrap;">Image</button>
            <input id="file-input" type="file" accept="image/*" hidden />
            <button id="clear-img-btn" type="button" class="secondary" title="Remove image">&#x2715;</button>
            <span id="img-name" class="meta" style="flex:1;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
          </div>
          <div class="dp-row">
            <span class="dp-label">W</span>
            <input id="img-w-range" type="range" min="8" max="640" value="320" style="flex:1;" />
            <span id="img-w-value" class="dp-val">320px</span>
          </div>
          <div class="dp-row">
            <span class="dp-label">X</span>
            <input id="img-x-range" type="range" min="-320" max="320" value="0" style="flex:1;" />
            <span id="img-x-value" class="dp-val">0</span>
            <span class="dp-label">Y</span>
            <input id="img-y-range" type="range" min="-96" max="96" value="0" style="flex:1;" />
            <span id="img-y-value" class="dp-val">0</span>
          </div>
        </div>

        <!-- Text -->
        <div class="dp-section">
          <div class="dp-row">
            <input id="text-input" type="text" placeholder="Label text…" style="flex:1;min-width:0;" />
            <button id="text-clear-btn" type="button" class="secondary" title="Clear text">&#x2715;</button>
          </div>
          <div class="dp-row" style="flex-wrap:wrap;">
            <select id="font-select" style="flex:2;min-width:8rem;">
              <option value="Impact">Impact</option>
              <option value="Arial Black">Arial Black</option>
              <option value="Arial">Arial</option>
              <option value="Helvetica">Helvetica</option>
              <option value="Georgia">Georgia</option>
              <option value="Courier New">Courier New</option>
            </select>
            <input id="font-size-input" type="number" min="4" max="256" value="48" class="dp-number" title="Font size" />
            <input id="fill-color-input" type="color" value="#ffffff" class="dp-color" title="Text fill" />
            <input id="outline-color-input" type="color" value="#000000" class="dp-color" title="Outline colour" />
            <input id="outline-width-input" type="number" min="0" max="30" value="8" class="dp-number" title="Outline width" />
          </div>
          <div class="dp-row">
            <span class="dp-label">X</span>
            <input id="text-x-range" type="range" min="-320" max="320" value="0" style="flex:1;" />
            <span id="text-x-value" class="dp-val">0</span>
            <span class="dp-label">Y</span>
            <input id="text-y-range" type="range" min="-96" max="96" value="0" style="flex:1;" />
            <span id="text-y-value" class="dp-val">0</span>
          </div>
        </div>

        <!-- Brightness / Contrast -->
        <div class="dp-section">
          <div class="dp-row">
            <span class="dp-label">Brightness</span>
            <input id="brightness-range" type="range" min="-100" max="100" value="0" style="flex:1;" />
            <span id="brightness-value" class="dp-val">0</span>
          </div>
          <div class="dp-row">
            <span class="dp-label">Contrast</span>
            <input id="contrast-range" type="range" min="-100" max="100" value="0" style="flex:1;" />
            <span id="contrast-value" class="dp-val">0</span>
          </div>
        </div>

      </section>

      <!-- Preview + Print -->
      <section class="card">
        <div class="preview-landscape">
          <canvas id="preview-canvas"></canvas>
        </div>
        <p id="preview-status" class="status">No content.</p>
        <div class="dp-row" style="margin-top:0.6rem;flex-wrap:wrap;">
          <span class="dp-label">Density</span>
          <input id="density-range" type="range" min="1" max="15" value="3" style="flex:1;min-width:6rem;" />
          <span id="density-value" class="dp-val">3</span>
          <button id="print-btn" type="button" disabled style="margin-left:auto;">Print</button>
        </div>
      </section>

    </main>
  `;

  // ── Cache element references ──────────────────────────────────────────

  ui.connectBtn        = root.querySelector("#connect-btn");
  ui.connectStatus     = root.querySelector("#connect-status");
  ui.printerInfo       = root.querySelector("#printer-info");
  ui.uploadBtn         = root.querySelector("#upload-btn");
  ui.fileInput         = root.querySelector("#file-input");
  ui.clearImgBtn       = root.querySelector("#clear-img-btn");
  ui.imgName           = root.querySelector("#img-name");
  ui.ditherSelect      = root.querySelector("#dither-select");
  ui.bgColor           = root.querySelector("#bg-color");
  ui.invertInput       = root.querySelector("#invert-input");
  ui.imgWRange         = root.querySelector("#img-w-range");
  ui.imgWValue         = root.querySelector("#img-w-value");
  ui.imgXRange         = root.querySelector("#img-x-range");
  ui.imgXValue         = root.querySelector("#img-x-value");
  ui.imgYRange         = root.querySelector("#img-y-range");
  ui.imgYValue         = root.querySelector("#img-y-value");
  ui.textInput         = root.querySelector("#text-input");
  ui.textClearBtn      = root.querySelector("#text-clear-btn");
  ui.fontSelect        = root.querySelector("#font-select");
  ui.fontSizeInput     = root.querySelector("#font-size-input");
  ui.fillColorInput    = root.querySelector("#fill-color-input");
  ui.outlineColorInput = root.querySelector("#outline-color-input");
  ui.outlineWidthInput = root.querySelector("#outline-width-input");
  ui.textXRange        = root.querySelector("#text-x-range");
  ui.textXValue        = root.querySelector("#text-x-value");
  ui.textYRange        = root.querySelector("#text-y-range");
  ui.textYValue        = root.querySelector("#text-y-value");
  ui.brightnessRange   = root.querySelector("#brightness-range");
  ui.brightnessValue   = root.querySelector("#brightness-value");
  ui.contrastRange     = root.querySelector("#contrast-range");
  ui.contrastValue     = root.querySelector("#contrast-value");
  ui.previewCanvas     = root.querySelector("#preview-canvas");
  ui.previewStatus     = root.querySelector("#preview-status");
  ui.densityRange      = root.querySelector("#density-range");
  ui.densityValue      = root.querySelector("#density-value");
  ui.printBtn          = root.querySelector("#print-btn");

  // ── Printer ──────────────────────────────────────────────────────────

  ui.connectBtn.addEventListener("click", async () => {
    if (state.ble.connected) {
      await disconnectPrinter();
    } else {
      setStatus("Connecting…");
      try { await connectPrinter(); } catch (err) { setStatus(err.message); }
    }
    updateUI();
  });

  // ── Image ────────────────────────────────────────────────────────────

  ui.uploadBtn.addEventListener("click", () => ui.fileInput.click());

  ui.fileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (ui.previewStatus) ui.previewStatus.textContent = "Loading…";
    try {
      await loadImage(file);
      if (ui.imgName) ui.imgName.textContent = file.name;
    } catch (err) {
      const msg = (err instanceof DOMException || err.message.includes("decode"))
        ? "Could not decode image. Try a different file."
        : `Error: ${err.message}`;
      if (ui.previewStatus) ui.previewStatus.textContent = msg;
    }
    ui.fileInput.value = "";
  });

  ui.clearImgBtn.addEventListener("click", () => {
    state.image.element  = null;
    state.image.fileName = "";
    if (ui.imgName) ui.imgName.textContent = "";
    reprocessImage();
  });

  ui.imgWRange.addEventListener("input", () => {
    state.image.drawW    = Number(ui.imgWRange.value);
    ui.imgWValue.textContent = `${state.image.drawW}px`;
    reprocessImage();
  });

  ui.imgXRange.addEventListener("input", () => {
    state.image.x        = Number(ui.imgXRange.value);
    ui.imgXValue.textContent = state.image.x;
    reprocessImage();
  });

  ui.imgYRange.addEventListener("input", () => {
    state.image.y        = Number(ui.imgYRange.value);
    ui.imgYValue.textContent = state.image.y;
    reprocessImage();
  });

  // ── Dithering / global ────────────────────────────────────────────────

  ui.ditherSelect.addEventListener("change", () => {
    state.settings.dithering = ui.ditherSelect.value;
    reprocessImage();
  });

  ui.bgColor.addEventListener("input", () => {
    state.settings.bgColor = ui.bgColor.value;
    reprocessImage();
  });

  ui.invertInput.addEventListener("change", () => {
    state.settings.invert = ui.invertInput.checked;
    reprocessImage();
  });

  // ── Text ─────────────────────────────────────────────────────────────

  ui.textInput.addEventListener("input", () => {
    state.text.content = ui.textInput.value;
    reprocessImage();
  });

  ui.textClearBtn.addEventListener("click", () => {
    state.text.content = "";
    ui.textInput.value = "";
    reprocessImage();
  });

  ui.fontSelect.addEventListener("change", () => {
    state.text.fontFamily = ui.fontSelect.value;
    reprocessImage();
  });

  ui.fontSizeInput.addEventListener("input", () => {
    const v = Math.max(4, Number(ui.fontSizeInput.value));
    state.text.fontSize = v;
    reprocessImage();
  });

  ui.fillColorInput.addEventListener("input", () => {
    state.text.fillColor = ui.fillColorInput.value;
    reprocessImage();
  });

  ui.outlineColorInput.addEventListener("input", () => {
    state.text.outlineColor = ui.outlineColorInput.value;
    reprocessImage();
  });

  ui.outlineWidthInput.addEventListener("input", () => {
    state.text.outlineWidth = Math.max(0, Number(ui.outlineWidthInput.value));
    reprocessImage();
  });

  ui.textXRange.addEventListener("input", () => {
    state.text.x = Number(ui.textXRange.value);
    ui.textXValue.textContent = state.text.x;
    reprocessImage();
  });

  ui.textYRange.addEventListener("input", () => {
    state.text.y = Number(ui.textYRange.value);
    ui.textYValue.textContent = state.text.y;
    reprocessImage();
  });

  // ── Brightness / Contrast ─────────────────────────────────────────────

  ui.brightnessRange.addEventListener("input", () => {
    state.settings.brightness = Number(ui.brightnessRange.value);
    ui.brightnessValue.textContent = ui.brightnessRange.value;
    reprocessImage();
  });

  ui.contrastRange.addEventListener("input", () => {
    state.settings.contrast = Number(ui.contrastRange.value);
    ui.contrastValue.textContent = ui.contrastRange.value;
    reprocessImage();
  });

  // ── Density ───────────────────────────────────────────────────────────

  ui.densityRange.addEventListener("input", () => {
    state.settings.density = Number(ui.densityRange.value);
    ui.densityValue.textContent = ui.densityRange.value;
  });

  // ── Print ─────────────────────────────────────────────────────────────

  ui.printBtn.addEventListener("click", async () => {
    if (!state.print.bitmap || !state.ble.connected) return;
    state.status.printing = true;
    updateUI();
    setStatus("Sending print job…");
    try {
      const payload = buildPrintPayload(
        state.print.bitmap,
        state.print.printWidth,
        state.print.printHeight,
        state.settings.density,
      );
      await writePrintPayload(payload);
      setStatus("Print job sent.");
    } catch (err) {
      setStatus(`Print failed: ${err.message}`);
    } finally {
      state.status.printing = false;
      updateUI();
    }
  });

  // Initial render (empty label)
  reprocessImage();
  updateUI();
}

const root = document.querySelector("#app");
if (!root) throw new Error("Missing #app root element");
renderApp(root);
