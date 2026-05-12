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

const PREVIEW_SCALE  = 2;    // Display the label canvas 2× for visibility
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
    // Full-width-scaled grayscale buffer (width = PRINT_WIDTH, height = fullHeight)
    rawGray:    null,
    fullHeight: 0,
    cropY:      0,    // top edge of the PRINT_HEIGHT-tall crop window
    // Computed output (updated by reprocessImage)
    bitmap:   null,   // Uint8Array: packed 1-bit, MSB first
    width:    0,
    height:   0,
    fileName: "",
  },
  settings: {
    density:    3,
    useDither:  true,
    invert:     false,
    brightness: 0,   // -100 to +100
    contrast:   0,   // -100 to +100
  },
  text: {
    content:    "",
    fontSize:   14,   // canvas pixels (displayed at PREVIEW_SCALE×)
    fontFamily: "sans-serif",
    x: 2,
    y: 0,   // top of text in canvas-pixel coordinates (textBaseline = "top")
  },
  drag: {
    active:      false,
    startMouseX: 0,
    startMouseY: 0,
    startTextX:  0,
    startTextY:  0,
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

async function connectPrinter() {
  if (!state.ble.supported) {
    throw new Error("Web Bluetooth is not available in this browser.");
  }

  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [PRINTER_BLE.serviceUuid] }],
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

  // Scale image so its width is exactly PRINT_WIDTH (96 dots), upscaling allowed.
  // The user will crop vertically if the image is taller than PRINT_HEIGHT.
  const scale = PRINT_WIDTH / img.naturalWidth;
  const w     = PRINT_WIDTH;
  const h     = Math.max(1, Math.round(img.naturalHeight * scale));

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

  state.image.rawGray    = gray;
  state.image.fullHeight = h;
  state.image.cropY      = 0;
  state.image.fileName   = file.name;

  syncCropSlider();
  reprocessImage();
}

// Apply brightness and contrast adjustments to a grayscale buffer.
// brightness: -100 to +100 (shifts pixel values by up to ±255)
// contrast:   -100 to +100 (standard photoshop-style midpoint scaling)
function applyBrightnessContrast(gray, brightness, contrast) {
  const bShift = brightness * 2.55;
  // Map contrast [-100, 100] → [-255, 255] then apply standard formula.
  const c      = contrast * 2.55;
  const factor = (259 * (c + 255)) / (255 * (259 - c));

  return new Float32Array(gray.map((v) => {
    let val = factor * ((v + bShift) - 128) + 128;
    return Math.max(0, Math.min(255, val));
  }));
}

// Atkinson dithering — distributes 6/8 of the quantization error to 6 neighbors.
// Each neighbor receives 1/8 of the error; the remaining 1/4 is discarded.
// This produces crisper halftones with cleaner highlights than Floyd-Steinberg.
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
      const err  = (old - next) / 8;  // 1/8 of error to each of 6 neighbors

      if (x + 1 < width)           buf[idx + 1]             += err;
      if (x + 2 < width)           buf[idx + 2]             += err;
      if (y + 1 < height) {
        if (x > 0)                 buf[idx + width - 1]     += err;
                                   buf[idx + width]         += err;
        if (x + 1 < width)         buf[idx + width + 1]     += err;
      }
      if (y + 2 < height)          buf[idx + 2 * width]     += err;
    }
  }

  return new Uint8Array(buf.map((v) => (v < 128 ? 0 : 255)));
}

// Simple midpoint threshold — no error diffusion.
function applyThreshold(gray) {
  return new Uint8Array(gray.map((v) => (v < 128 ? 0 : 255)));
}

// Composite text from state.text onto a grayscale Float32Array (in-place).
// Black text is burned directly into the buffer before dithering.
function compositeText(grayBuf, width, height) {
  const { content, fontSize, fontFamily, x, y } = state.text;
  if (!content) return;

  const tmp = document.createElement("canvas");
  tmp.width  = width;
  tmp.height = height;
  const ctx = tmp.getContext("2d");

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle    = "black";
  ctx.font         = `bold ${fontSize}px ${fontFamily}`;
  ctx.textBaseline = "top";
  ctx.fillText(content, x, y);

  const px = ctx.getImageData(0, 0, width, height).data;

  // Blend: where the text alpha > 0, darken the grayscale pixel proportionally.
  for (let i = 0; i < width * height; i++) {
    const alpha = px[i * 4 + 3] / 255;
    if (alpha > 0) {
      grayBuf[i] = Math.max(0, grayBuf[i] * (1 - alpha));
    }
  }
}

// Pack a 0/255 pixel buffer into 1-bit-per-pixel (MSB = leftmost pixel).
function packBitmap(pixels, width, height) {
  const bytesPerRow = Math.ceil(width / 8);
  const bitmap      = new Uint8Array(bytesPerRow * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x] === 0) {
        bitmap[y * bytesPerRow + Math.floor(x / 8)] |= 1 << (7 - (x % 8));
      }
    }
  }

  return bitmap;
}

// Update the crop slider range to match the current full-height image.
function syncCropSlider() {
  if (!ui.cropRow || !ui.cropSlider) return;
  const maxCrop = Math.max(0, state.image.fullHeight - PRINT_HEIGHT);
  ui.cropRow.hidden   = maxCrop === 0;
  ui.cropSlider.max   = maxCrop;
  ui.cropSlider.value = state.image.cropY;
  if (ui.cropValue) ui.cropValue.textContent = state.image.cropY;
}

// Full image pipeline: crop → brightness/contrast → invert → text → dither → preview.
function reprocessImage() {
  const { rawGray, fullHeight, cropY, fileName } = state.image;
  if (!rawGray) return;

  // 1. Crop: extract the PRINT_WIDTH × printH window starting at cropY.
  const printH  = Math.min(PRINT_HEIGHT, fullHeight - cropY);
  const cropped = new Float32Array(PRINT_WIDTH * printH);
  for (let row = 0; row < printH; row++) {
    const srcStart = (cropY + row) * PRINT_WIDTH;
    cropped.set(rawGray.subarray(srcStart, srcStart + PRINT_WIDTH), row * PRINT_WIDTH);
  }

  // 2. Brightness / contrast.
  let adjusted = applyBrightnessContrast(
    cropped, state.settings.brightness, state.settings.contrast
  );

  // 3. Invert.
  if (state.settings.invert) {
    for (let i = 0; i < adjusted.length; i++) adjusted[i] = 255 - adjusted[i];
  }

  // 4. Text overlay (burns text into grayscale before dithering).
  compositeText(adjusted, PRINT_WIDTH, printH);

  // 5. Dither or threshold.
  const dithered = state.settings.useDither
    ? atkinsonDither(adjusted, PRINT_WIDTH, printH)
    : applyThreshold(adjusted);

  // 6. Store output.
  state.image.bitmap = packBitmap(dithered, PRINT_WIDTH, printH);
  state.image.width  = PRINT_WIDTH;
  state.image.height = printH;

  drawPreview(dithered, PRINT_WIDTH, printH, fileName);
  updateUI();
}

function drawPreview(pixels, width, height, fileName) {
  if (!ui.previewCanvas) return;

  const canvas  = ui.previewCanvas;
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

  canvas.style.width  = (width  * PREVIEW_SCALE) + "px";
  canvas.style.height = (height * PREVIEW_SCALE) + "px";

  const bytes = Math.ceil(width / 8) * height;
  if (ui.previewStatus) {
    const label = fileName ? ` · ${fileName}` : "";
    ui.previewStatus.textContent = `${width}×${height} px · ${bytes} bytes${label}`;
  }
}

// ── Print payload ─────────────────────────────────────────────────────────

// Build the full AY/ESC print payload using the uncompressed GS v 0 image command.
// Sequence: ENABLE → WAKEUP → LOCATION → DENSITY → PAPER_TYPE → IMAGE →
//           LINE_DOT → POSITION → STOP_JOB
function buildPrintPayload(bitmap, width, height, density) {
  const clampedDensity = Math.max(1, Math.min(15, Math.round(density)));
  const bytesPerRow    = Math.ceil(width / 8);

  const parts = [
    new Uint8Array(CMD_ENABLE),
    new Uint8Array(CMD_WAKEUP),
    new Uint8Array(CMD_LOCATION_CTR),
    new Uint8Array([0x10, 0xFF, 0x10, 0x00, clampedDensity]),  // density
    new Uint8Array([0x10, 0xFF, 0x10, 0x03, 0x00]),             // paper: gap (0)
    // GS v 0: uncompressed image — dimensions are little-endian
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

  // Show "move" cursor on the preview canvas only when there is text to drag.
  if (ui.previewCanvas) {
    ui.previewCanvas.style.cursor = state.text.content ? "move" : "default";
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
            Image is scaled to the full 96-dot (12&thinsp;mm) print width.
            If taller than the label, use the crop slider in the preview to choose which
            part to print.
          </p>
        </div>
        <div class="button-row">
          <button id="upload-btn" type="button">Upload Image</button>
        </div>
        <input id="file-input" type="file" accept="image/*" hidden />

        <div class="settings-row" style="margin-top: 0.75rem;">
          <label for="brightness-range">Brightness</label>
          <input id="brightness-range" type="range" min="-100" max="100" value="0" style="flex: 1;" />
          <code id="brightness-value">0</code>
        </div>

        <div class="settings-row">
          <label for="contrast-range">Contrast</label>
          <input id="contrast-range" type="range" min="-100" max="100" value="0" style="flex: 1;" />
          <code id="contrast-value">0</code>
        </div>

        <div class="settings-row">
          <label for="density-range">Density</label>
          <input id="density-range" type="range" min="1" max="15" value="3" style="flex: 1;" />
          <code id="density-value">3</code>
        </div>

        <label class="settings-row checkbox-row">
          <input id="dither-input" type="checkbox" checked />
          <span>Atkinson dithering</span>
        </label>

        <label class="settings-row checkbox-row">
          <input id="invert-input" type="checkbox" />
          <span>Invert (swap black &amp; white)</span>
        </label>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Text</h2>
          <p class="section-copy">
            Drag the preview canvas to reposition the text on the label.
          </p>
        </div>
        <div class="settings-row">
          <input id="text-input" type="text" placeholder="Label text…" />
        </div>
        <div class="settings-row" style="margin-top: 0.5rem;">
          <label for="font-size-range">Size</label>
          <input id="font-size-range" type="range" min="4" max="32" value="14" style="flex: 1;" />
          <code id="font-size-value">14</code>
        </div>
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
        <div id="crop-row" class="settings-row" style="margin-top: 0.75rem;" hidden>
          <label for="crop-slider">Crop position</label>
          <input id="crop-slider" type="range" min="0" max="0" value="0" style="flex: 1;" />
          <code id="crop-value">0</code>
        </div>
        <p id="preview-status" class="status">No image loaded.</p>
      </section>

    </main>
  `;

  // Cache element references.
  ui.connectBtn      = root.querySelector("#connect-btn");
  ui.connectStatus   = root.querySelector("#connect-status");
  ui.printerInfo     = root.querySelector("#printer-info");
  ui.uploadBtn       = root.querySelector("#upload-btn");
  ui.fileInput       = root.querySelector("#file-input");
  ui.brightnessRange = root.querySelector("#brightness-range");
  ui.brightnessValue = root.querySelector("#brightness-value");
  ui.contrastRange   = root.querySelector("#contrast-range");
  ui.contrastValue   = root.querySelector("#contrast-value");
  ui.densityRange    = root.querySelector("#density-range");
  ui.densityValue    = root.querySelector("#density-value");
  ui.ditherInput     = root.querySelector("#dither-input");
  ui.invertInput     = root.querySelector("#invert-input");
  ui.textInput       = root.querySelector("#text-input");
  ui.fontSizeRange   = root.querySelector("#font-size-range");
  ui.fontSizeValue   = root.querySelector("#font-size-value");
  ui.previewCanvas   = root.querySelector("#preview-canvas");
  ui.cropRow         = root.querySelector("#crop-row");
  ui.cropSlider      = root.querySelector("#crop-slider");
  ui.cropValue       = root.querySelector("#crop-value");
  ui.previewStatus   = root.querySelector("#preview-status");
  ui.printBtn        = root.querySelector("#print-btn");

  // ── Printer ──────────────────────────────────────────────────────────

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

  // ── Image ────────────────────────────────────────────────────────────

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
    // Reset so the same file can be re-selected after changing settings.
    ui.fileInput.value = "";
  });

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

  ui.densityRange.addEventListener("input", () => {
    state.settings.density = Number(ui.densityRange.value);
    ui.densityValue.textContent = ui.densityRange.value;
  });

  ui.ditherInput.addEventListener("change", () => {
    state.settings.useDither = ui.ditherInput.checked;
    reprocessImage();
  });

  ui.invertInput.addEventListener("change", () => {
    state.settings.invert = ui.invertInput.checked;
    reprocessImage();
  });

  // ── Text ─────────────────────────────────────────────────────────────

  ui.textInput.addEventListener("input", () => {
    state.text.content = ui.textInput.value;
    // Reset position to top-left when text is first entered.
    if (state.text.content && state.image.rawGray) {
      state.text.x = 2;
      state.text.y = 0;
    }
    updateUI();
    reprocessImage();
  });

  ui.fontSizeRange.addEventListener("input", () => {
    state.text.fontSize = Number(ui.fontSizeRange.value);
    ui.fontSizeValue.textContent = ui.fontSizeRange.value;
    reprocessImage();
  });

  // ── Crop ─────────────────────────────────────────────────────────────

  ui.cropSlider.addEventListener("input", () => {
    state.image.cropY = Number(ui.cropSlider.value);
    ui.cropValue.textContent = ui.cropSlider.value;
    reprocessImage();
  });

  // ── Text drag on preview canvas (mouse + touch) ───────────────────────

  function canvasCoords(e) {
    const rect   = ui.previewCanvas.getBoundingClientRect();
    const scaleX = ui.previewCanvas.width  / ui.previewCanvas.clientWidth;
    const scaleY = ui.previewCanvas.height / ui.previewCanvas.clientHeight;
    const src    = e.touches ? e.touches[0] : e;
    return {
      x: (src.clientX - rect.left) * scaleX,
      y: (src.clientY - rect.top)  * scaleY,
    };
  }

  function onDragStart(e) {
    if (!state.text.content) return;
    const { x, y }        = canvasCoords(e);
    state.drag.active      = true;
    state.drag.startMouseX = x;
    state.drag.startMouseY = y;
    state.drag.startTextX  = state.text.x;
    state.drag.startTextY  = state.text.y;
    e.preventDefault();
  }

  function onDragMove(e) {
    if (!state.drag.active) return;
    const { x, y } = canvasCoords(e);
    state.text.x = Math.round(state.drag.startTextX + (x - state.drag.startMouseX));
    state.text.y = Math.round(state.drag.startTextY + (y - state.drag.startMouseY));
    reprocessImage();
    e.preventDefault();
  }

  function onDragEnd() { state.drag.active = false; }

  ui.previewCanvas.addEventListener("mousedown",  onDragStart);
  ui.previewCanvas.addEventListener("mousemove",  onDragMove);
  ui.previewCanvas.addEventListener("mouseup",    onDragEnd);
  ui.previewCanvas.addEventListener("mouseleave", onDragEnd);
  ui.previewCanvas.addEventListener("touchstart", onDragStart, { passive: false });
  ui.previewCanvas.addEventListener("touchmove",  onDragMove,  { passive: false });
  ui.previewCanvas.addEventListener("touchend",   onDragEnd);

  // ── Print ─────────────────────────────────────────────────────────────

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
