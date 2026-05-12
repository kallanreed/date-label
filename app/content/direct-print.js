// ── Constants ─────────────────────────────────────────────────────────────

// D12 thermal label printer BLE UUIDs (AY protocol)
const PRINTER_BLE = {
  serviceUuid: "0000ff00-0000-1000-8000-00805f9b34fb",
  writeUuid:   "0000ff02-0000-1000-8000-00805f9b34fb",
  notifyUuid:  "0000ff03-0000-1000-8000-00805f9b34fb",
};

// D12 print area: 12 mm × 40 mm at 203 DPI
const PRINT_WIDTH  = 96;   // dots across (12 mm)
const PRINT_HEIGHT = 320;  // dots tall   (40 mm)

const CHUNK_SIZE     = 1024;
const CHUNK_DELAY_MS = 5;

// AY/ESC binary command bytes
const CMD_ENABLE       = [0x10, 0xFF, 0xFE, 0x01];
const CMD_WAKEUP       = new Array(12).fill(0x00);
const CMD_LOCATION_CTR = [0x1B, 0x61, 0x01];        // center alignment
const CMD_LINE_DOT     = [0x1B, 0x4A, 0x0A];        // advance 10 dot-lines
const CMD_POSITION     = [0x1D, 0x0C];              // gap/label detection
const CMD_STOP         = [0x10, 0xFF, 0xFE, 0x45];  // triggers print
const CMD_BATTERY      = [0x10, 0xFF, 0x50, 0xF1];
const CMD_VERSION      = [0x10, 0xFF, 0x20, 0xF1];

// ── State ─────────────────────────────────────────────────────────────────

const state = {
  ble: {
    supported: typeof navigator !== "undefined" && "bluetooth" in navigator,
    device:    null,
    writeChar: null,
    notifyChar: null,
    connected: false,
  },
  image: {
    grayBuf:  null,   // Float32Array: grayscale values 0–255
    width:    0,
    height:   0,
    bitmap:   null,   // Uint8Array: packed 1-bit, MSB first
    fileName: "",
  },
  settings: {
    density:   3,
    useDither: true,
    invert:    false,
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
  state.ble.device    = null;
  state.ble.writeChar = null;
  state.ble.notifyChar = null;
  state.ble.connected  = false;
  state.status.printing = false;
  if (ui.printerInfo) ui.printerInfo.textContent = "";
  setStatus("Disconnected.");
  updateUI();
}

async function connectPrinter() {
  if (!state.ble.supported) {
    throw new Error("Web Bluetooth is not available in this browser.");
  }

  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [PRINTER_BLE.serviceUuid] }],
  });

  device.addEventListener("gattserverdisconnected", handleDisconnect);

  const server    = await device.gatt.connect();
  const service   = await server.getPrimaryService(PRINTER_BLE.serviceUuid);
  const writeChar = await service.getCharacteristic(PRINTER_BLE.writeUuid);
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
  if (state.ble.device?.gatt?.connected) {
    state.ble.device.gatt.disconnect();
  }
  handleDisconnect();
}

// Send a query command and collect notifications for `responseTimeoutMs` milliseconds.
async function queryPrinter(cmdBytes, responseTimeoutMs = 600) {
  if (!state.ble.writeChar || !state.ble.notifyChar) return null;

  const chunks = [];
  const handler = (event) => {
    chunks.push(new Uint8Array(event.target.value.buffer));
  };

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

// Send the print payload in 1024-byte chunks with 5 ms inter-chunk delay.
async function writePrintPayload(payload) {
  for (let off = 0; off < payload.length; off += CHUNK_SIZE) {
    const chunk = payload.slice(off, off + CHUNK_SIZE);
    await writeBytes(chunk);
    if (off + CHUNK_SIZE < payload.length) {
      await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
    }
  }
}

async function fetchPrinterInfo() {
  try {
    const bat = await queryPrinter(CMD_BATTERY);
    const ver = await queryPrinter(CMD_VERSION);

    const parts = [];

    if (bat && bat.length >= 2) {
      const charging = bat[0] === 0x02;
      parts.push(`Battery: ${bat[1]}%${charging ? " ⚡" : ""}`);
    }

    if (ver && ver.length > 0) {
      const text = new TextDecoder().decode(ver).replace(/\0/g, "").trim();
      if (text) parts.push(`FW: ${text}`);
    }

    if (ui.printerInfo && parts.length) {
      ui.printerInfo.textContent = parts.join(" · ");
    }
  } catch {
    // Info fetch is best-effort; ignore errors.
  }
}

// ── Image processing ──────────────────────────────────────────────────────

async function loadImage(file) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.src = url;
  await img.decode();
  URL.revokeObjectURL(url);

  // Scale image to fit within the label's print area, maintaining aspect ratio.
  // Never upscale beyond native resolution.
  const scale = Math.min(
    PRINT_WIDTH  / img.naturalWidth,
    PRINT_HEIGHT / img.naturalHeight,
    1,
  );
  const w = Math.max(1, Math.round(img.naturalWidth  * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  // Draw onto a temporary canvas with a white background.
  const tempCanvas = document.createElement("canvas");
  tempCanvas.width  = w;
  tempCanvas.height = h;
  const ctx = tempCanvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  // Convert RGBA pixels to grayscale using ITU-R BT.601 luma coefficients.
  const px   = ctx.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  }

  state.image.grayBuf  = gray;
  state.image.width    = w;
  state.image.height   = h;
  state.image.fileName = file.name;

  reprocessImage();
}

// Re-run dither/threshold from the stored grayscale buffer.
// Called when settings change or after initial load.
function reprocessImage() {
  const { grayBuf, width, height } = state.image;
  if (!grayBuf) return;

  const { useDither, invert } = state.settings;

  // Optionally invert (swap black ↔ white).
  const input = invert
    ? new Float32Array(grayBuf.map((v) => 255 - v))
    : Float32Array.from(grayBuf);

  const dithered = useDither
    ? floydSteinberg(input, width, height)
    : applyThreshold(input);

  state.image.bitmap = packBitmap(dithered, width, height);
  drawPreview(dithered, width, height);
  updateUI();
}

// Floyd-Steinberg error-diffusion dithering.
// Returns a Uint8Array of 0 (black) or 255 (white) per pixel.
function floydSteinberg(gray, width, height) {
  const buf = Float32Array.from(gray);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx  = y * width + x;
      const old  = Math.max(0, Math.min(255, buf[idx]));
      const next = old < 128 ? 0 : 255;
      buf[idx]   = next;
      const err  = old - next;

      if (x + 1 < width)
        buf[idx + 1]         += (err * 7) / 16;
      if (y + 1 < height) {
        if (x > 0)
          buf[idx + width - 1] += (err * 3) / 16;
        buf[idx + width]       += (err * 5) / 16;
        if (x + 1 < width)
          buf[idx + width + 1] += (err * 1) / 16;
      }
    }
  }

  return new Uint8Array(buf.map((v) => (v < 128 ? 0 : 255)));
}

// Simple midpoint threshold — no error diffusion.
function applyThreshold(gray) {
  return new Uint8Array(gray.map((v) => (v < 128 ? 0 : 255)));
}

// Pack a 0/255 pixel array into a 1-bit-per-pixel bitmap.
// Bit ordering: MSB = leftmost pixel (bit 7), matching the AY protocol.
function packBitmap(pixels, width, height) {
  const bytesPerRow = Math.ceil(width / 8);
  const bitmap = new Uint8Array(bytesPerRow * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x] === 0) {  // black
        const byteIdx = y * bytesPerRow + Math.floor(x / 8);
        bitmap[byteIdx] |= 1 << (7 - (x % 8));
      }
    }
  }

  return bitmap;
}

function drawPreview(pixels, width, height) {
  if (!ui.previewCanvas) return;

  const canvas = ui.previewCanvas;
  canvas.width  = width;
  canvas.height = height;

  const ctx     = canvas.getContext("2d");
  const imgData = ctx.createImageData(width, height);

  for (let i = 0; i < width * height; i++) {
    const v = pixels[i];
    imgData.data[i * 4]     = v;
    imgData.data[i * 4 + 1] = v;
    imgData.data[i * 4 + 2] = v;
    imgData.data[i * 4 + 3] = 255;
  }

  ctx.putImageData(imgData, 0, 0);

  // Scale up 2× so the tiny label area is comfortably visible.
  canvas.style.width  = (width  * 2) + "px";
  canvas.style.height = (height * 2) + "px";

  const bytes = Math.ceil(width / 8) * height;
  if (ui.previewStatus) {
    ui.previewStatus.textContent =
      `${width}×${height} px · ${bytes} bytes · ${state.image.fileName}`;
  }
}

// ── Print payload ─────────────────────────────────────────────────────────

// Build the full AY/ESC print payload using the uncompressed GS v 0 image command.
// Sequence: ENABLE → WAKEUP → LOCATION → DENSITY → PAPER_TYPE → IMAGE →
//           LINE_DOT → POSITION → STOP_JOB
function buildPrintPayload(bitmap, width, height, density) {
  const clampedDensity = Math.max(1, Math.min(15, Math.round(density)));
  const bytesPerRow = Math.ceil(width / 8);

  const parts = [
    new Uint8Array(CMD_ENABLE),
    new Uint8Array(CMD_WAKEUP),
    new Uint8Array(CMD_LOCATION_CTR),
    new Uint8Array([0x10, 0xFF, 0x10, 0x00, clampedDensity]),  // density
    new Uint8Array([0x10, 0xFF, 0x10, 0x03, 0x00]),            // paper: gap (0)
    // GS v 0: uncompressed image — widths and heights are little-endian
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
  for (const part of parts) {
    payload.set(part, offset);
    offset += part.length;
  }
  return payload;
}

// ── UI ────────────────────────────────────────────────────────────────────

function updateUI() {
  const connected = state.ble.connected;
  const hasBitmap = !!state.image.bitmap;

  if (ui.connectBtn) {
    ui.connectBtn.textContent = connected ? "Disconnect" : "Connect Printer";
    ui.connectBtn.className   = connected ? "secondary"  : "primary";
    ui.connectBtn.disabled    = !state.ble.supported;
  }

  if (!state.ble.supported && ui.connectStatus) {
    ui.connectStatus.textContent = "Web Bluetooth is not available in this browser.";
  }

  if (ui.printBtn) {
    ui.printBtn.disabled = !connected || !hasBitmap || state.status.printing;
  }
}

function renderApp(root) {
  root.innerHTML = `
    <main class="layout">

      <section class="card compact-card">
        <div class="card-header">
          <h2>Printer</h2>
        </div>
        <div class="button-row">
          <button id="connect-btn" class="primary" type="button">Connect Printer</button>
        </div>
        <p id="connect-status" class="status">Not connected.</p>
        <p id="printer-info" class="meta"></p>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Image</h2>
          <p class="section-copy">
            Upload an image — it will be scaled to fit the 12&thinsp;×&thinsp;40&thinsp;mm
            print area (96&thinsp;×&thinsp;320 dots at 203&thinsp;DPI).
          </p>
        </div>
        <div class="button-row">
          <button id="upload-btn" type="button">Upload Image</button>
        </div>
        <input id="file-input" type="file" accept="image/*" hidden />

        <div class="settings-row" style="margin-top: 0.75rem;">
          <label for="density-range">Density</label>
          <input id="density-range" type="range" min="1" max="15" value="3" style="flex: 1;" />
          <code id="density-value">3</code>
        </div>

        <label class="settings-row checkbox-row">
          <input id="dither-input" type="checkbox" checked />
          <span>Floyd-Steinberg dithering</span>
        </label>

        <label class="settings-row checkbox-row">
          <input id="invert-input" type="checkbox" />
          <span>Invert (swap black &amp; white)</span>
        </label>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Preview</h2>
        </div>
        <div class="preview-row">
          <div class="preview-shell">
            <canvas id="preview-canvas" class="preview-canvas"></canvas>
          </div>
          <div class="preview-actions">
            <button id="print-btn" type="button" disabled>Print</button>
          </div>
        </div>
        <p id="preview-status" class="status">No image loaded.</p>
      </section>

    </main>
  `;

  // Cache element references.
  ui.connectBtn    = root.querySelector("#connect-btn");
  ui.connectStatus = root.querySelector("#connect-status");
  ui.printerInfo   = root.querySelector("#printer-info");
  ui.uploadBtn     = root.querySelector("#upload-btn");
  ui.fileInput     = root.querySelector("#file-input");
  ui.densityRange  = root.querySelector("#density-range");
  ui.densityValue  = root.querySelector("#density-value");
  ui.ditherInput   = root.querySelector("#dither-input");
  ui.invertInput   = root.querySelector("#invert-input");
  ui.previewCanvas = root.querySelector("#preview-canvas");
  ui.previewStatus = root.querySelector("#preview-status");
  ui.printBtn      = root.querySelector("#print-btn");

  // ── Event listeners ──────────────────────────────────────────────────

  ui.connectBtn.addEventListener("click", async () => {
    if (state.ble.connected) {
      await disconnectPrinter();
    } else {
      setStatus("Connecting…");
      try {
        await connectPrinter();
      } catch (err) {
        setStatus(err.message);
      }
    }
    updateUI();
  });

  ui.uploadBtn.addEventListener("click", () => ui.fileInput.click());

  ui.fileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (ui.previewStatus) ui.previewStatus.textContent = "Loading…";
    try {
      await loadImage(file);
    } catch (err) {
      const isDecodeError = err instanceof DOMException || err.message.includes("decode");
      const msg = isDecodeError
        ? "Could not decode image. Try a different PNG or JPEG file."
        : `Error loading image: ${err.message}`;
      if (ui.previewStatus) ui.previewStatus.textContent = msg;
    }
    // Reset so the same file can be re-selected after an invert/dither change.
    ui.fileInput.value = "";
  });

  ui.densityRange.addEventListener("input", () => {
    state.settings.density = Number(ui.densityRange.value);
    if (ui.densityValue) ui.densityValue.textContent = ui.densityRange.value;
  });

  ui.ditherInput.addEventListener("change", () => {
    state.settings.useDither = ui.ditherInput.checked;
    reprocessImage();
  });

  ui.invertInput.addEventListener("change", () => {
    state.settings.invert = ui.invertInput.checked;
    reprocessImage();
  });

  ui.printBtn.addEventListener("click", async () => {
    if (!state.image.bitmap || !state.ble.connected) return;

    state.status.printing = true;
    updateUI();
    setStatus("Sending print job…");

    try {
      const payload = buildPrintPayload(
        state.image.bitmap,
        state.image.width,
        state.image.height,
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

  updateUI();
}

const root = document.querySelector("#app");
if (!root) throw new Error("Missing #app root element");
renderApp(root);
