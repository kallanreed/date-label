const BLE_CONFIG = {
  configServiceUuid: "12345678-1234-1234-1234-123456789abc",
  writeUuid: "12345678-1234-1234-1234-00000000ff01",
  notifyUuid: "12345678-1234-1234-1234-00000000ff02",
};

const CMD = {
  WIFI_SCAN: 0x01,
  WIFI_CONNECT: 0x02,
  WIFI_GET_STATUS: 0x03,
  WIFI_GET_SAVED: 0x04,
  WIFI_CLEAR: 0x05,
  GET_TIME_STATUS: 0x06,
  GET_DATE_BITMAP: 0x07,
};

const RSP = {
  WIFI_SCAN_RESULT: 0x81,
  WIFI_SCAN_DONE: 0x82,
  WIFI_STATUS: 0x83,
  WIFI_SAVED: 0x84,
  ACK: 0x85,
  ERROR: 0x86,
  TIME_STATUS: 0x87,
  DATE_BITMAP_HEADER: 0x88,
  DATE_BITMAP_DATA: 0x89,
};

const WIFI_STATUS_NAME = {
  0x00: "Idle",
  0x01: "Connecting...",
  0x02: "Connected",
  0x03: "Failed",
  0x04: "Saved (disconnected)",
};

const ERROR_NAME = {
  0x01: "Unknown command",
  0x02: "Malformed payload",
  0x03: "Scan in progress",
  0x04: "Connect in progress",
  0x05: "NVS failure",
  0x06: "Time not synced",
  0x07: "Render failed",
};

const SCAN_TIMEOUT_MS = 15000;
const BLE_DEBUG = true;

const state = {
  ble: {
    supported: typeof navigator !== "undefined" && "bluetooth" in navigator,
    device: null,
    writeChar: null,
    notifyChar: null,
    connected: false,
    handler: null,
    commandChain: Promise.resolve(),
  },
  wifi: {
    status: 0x00,
    ssid: "",
    networks: [],
    scanning: false,
  },
  preview: {
    loading: false,
  },
};

const ui = {};

function debugLog(...args) {
  if (BLE_DEBUG) {
    console.debug("[ble]", ...args);
  }
}

// ── Protocol helpers ────────────────────────────────────────────────────

function encodeMsg(type, payload = new Uint8Array()) {
  const msg = new Uint8Array(2 + payload.length);
  msg[0] = type;
  msg[1] = payload.length;
  msg.set(payload, 2);
  return msg;
}

function parseMsg(dataView) {
  const bytes = new Uint8Array(
    dataView.buffer, dataView.byteOffset, dataView.byteLength
  );
  if (bytes.length < 2) return null;
  const payloadLength = bytes[1];
  const payload = bytes.slice(2, 2 + payloadLength);
  if (payload.length !== payloadLength) {
    debugLog("truncated message", {
      type: bytes[0],
      expectedPayloadLength: payloadLength,
      actualPayloadLength: payload.length,
      rawLength: bytes.length,
    });
  }
  return { type: bytes[0], payload };
}

function encodeWifiConnect(ssid, password) {
  const encoder = new TextEncoder();
  const ssidBytes = encoder.encode(ssid);
  const passBytes = encoder.encode(password);
  const payload = new Uint8Array(ssidBytes.length + 1 + passBytes.length);
  payload.set(ssidBytes, 0);
  payload[ssidBytes.length] = 0x00;
  payload.set(passBytes, ssidBytes.length + 1);
  return payload;
}

// ── BLE connection ──────────────────────────────────────────────────────

function setBleStatus(message) {
  if (ui.bleStatus) ui.bleStatus.textContent = message;
}

function setWifiStatus(message) {
  if (ui.wifiStatusText) ui.wifiStatusText.textContent = message;
}

function handleNotification(event) {
  const dataView = event.target?.value;
  if (!dataView) return;
  const msg = parseMsg(dataView);
  if (!msg) return;
  debugLog("notify", {
    type: `0x${msg.type.toString(16)}`,
    rawLength: dataView.byteLength,
    payloadLength: msg.payload.length,
  });

  if (state.ble.handler) {
    state.ble.handler(msg);
    return;
  }

  // Handle unsolicited status updates.
  if (msg.type === RSP.WIFI_STATUS) {
    handleWifiStatusMsg(msg.payload);
  }
}

function handleWifiStatusMsg(payload) {
  state.wifi.status = payload[0];
  state.wifi.ssid = payload.length > 1
    ? new TextDecoder().decode(payload.slice(1))
    : "";
  updateWifiUI();
}

function handleGattDisconnected() {
  state.ble.device = null;
  state.ble.writeChar = null;
  state.ble.notifyChar = null;
  state.ble.connected = false;
  state.ble.handler = null;
  state.ble.commandChain = Promise.resolve();
  setBleStatus("Disconnected.");
  updateUI();
}

async function connectBle() {
  if (!state.ble.supported) {
    throw new Error("Web Bluetooth is not available.");
  }

  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [BLE_CONFIG.configServiceUuid] }],
  });

  device.addEventListener("gattserverdisconnected", handleGattDisconnected);

  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(BLE_CONFIG.configServiceUuid);
  const writeChar = await service.getCharacteristic(BLE_CONFIG.writeUuid);
  const notifyChar = await service.getCharacteristic(BLE_CONFIG.notifyUuid);

  notifyChar.addEventListener("characteristicvaluechanged", handleNotification);
  await notifyChar.startNotifications();

  state.ble.device = device;
  state.ble.writeChar = writeChar;
  state.ble.notifyChar = notifyChar;
  state.ble.connected = true;

  setBleStatus(`Connected to ${device.name || "device"}.`);
  updateUI();

  await getWifiStatus();
  await loadPreview();
}

async function disconnectBle() {
  if (state.ble.device?.gatt?.connected) {
    state.ble.device.gatt.disconnect();
  }
  handleGattDisconnected();
}

async function writeCmd(type, payload = new Uint8Array()) {
  const command = async () => {
    if (!state.ble.writeChar) throw new Error("Not connected.");
    debugLog("write", {
      type: `0x${type.toString(16)}`,
      payloadLength: payload.length,
    });
    await state.ble.writeChar.writeValue(encodeMsg(type, payload));
  };

  const queued = state.ble.commandChain
    .catch(() => {})
    .then(command);

  state.ble.commandChain = queued;
  return queued;
}

function getWifiStatus() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.ble.handler = null;
      reject(new Error("Timed out."));
    }, 5000);

    state.ble.handler = (msg) => {
      if (msg.type === RSP.WIFI_STATUS) {
        clearTimeout(timeout);
        state.ble.handler = null;
        handleWifiStatusMsg(msg.payload);
        resolve({
          status: state.wifi.status,
          ssid: state.wifi.ssid,
        });
      } else if (msg.type === RSP.ERROR) {
        clearTimeout(timeout);
        state.ble.handler = null;
        const code = msg.payload.length > 1 ? msg.payload[1] : 0;
        reject(new Error(ERROR_NAME[code] || `Error 0x${code.toString(16)}`));
      }
    };

    writeCmd(CMD.WIFI_GET_STATUS).catch((err) => {
      clearTimeout(timeout);
      state.ble.handler = null;
      reject(err);
    });
  });
}

// ── WiFi scan ───────────────────────────────────────────────────────────

function scanWifi() {
  return new Promise((resolve, reject) => {
    const networks = [];
    const timeout = setTimeout(() => {
      state.ble.handler = null;
      state.wifi.scanning = false;
      updateUI();
      reject(new Error("Scan timed out."));
    }, SCAN_TIMEOUT_MS);

    state.ble.handler = (msg) => {
      if (msg.type === RSP.WIFI_SCAN_RESULT) {
        const rssi = new Int8Array(msg.payload.buffer, msg.payload.byteOffset, 1)[0];
        const ssid = new TextDecoder().decode(msg.payload.slice(1));
        networks.push({ ssid, rssi });
      } else if (msg.type === RSP.WIFI_SCAN_DONE) {
        clearTimeout(timeout);
        state.ble.handler = null;
        state.wifi.scanning = false;
        updateUI();
        resolve(networks);
      } else if (msg.type === RSP.ERROR) {
        clearTimeout(timeout);
        state.ble.handler = null;
        state.wifi.scanning = false;
        updateUI();
        const code = msg.payload.length > 1 ? msg.payload[1] : 0;
        reject(new Error(ERROR_NAME[code] || `Error 0x${code.toString(16)}`));
      }
    };

    state.wifi.scanning = true;
    updateUI();
    writeCmd(CMD.WIFI_SCAN).catch((err) => {
      clearTimeout(timeout);
      state.ble.handler = null;
      state.wifi.scanning = false;
      updateUI();
      reject(err);
    });
  });
}

// ── WiFi connect ────────────────────────────────────────────────────────

function connectWifi(ssid, password) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.ble.handler = null;
      reject(new Error("Connect timed out."));
    }, 20000);

    state.ble.handler = (msg) => {
      if (msg.type === RSP.WIFI_STATUS) {
        handleWifiStatusMsg(msg.payload);
        if (state.wifi.status === 0x02) {
          clearTimeout(timeout);
          state.ble.handler = null;
          resolve();
        } else if (state.wifi.status === 0x03) {
          clearTimeout(timeout);
          state.ble.handler = null;
          reject(new Error("Connection failed."));
        }
      } else if (msg.type === RSP.ERROR) {
        clearTimeout(timeout);
        state.ble.handler = null;
        const code = msg.payload.length > 1 ? msg.payload[1] : 0;
        reject(new Error(ERROR_NAME[code] || `Error 0x${code.toString(16)}`));
      }
    };

    writeCmd(CMD.WIFI_CONNECT, encodeWifiConnect(ssid, password)).catch((err) => {
      clearTimeout(timeout);
      state.ble.handler = null;
      reject(err);
    });
  });
}

// ── Saved creds (debug) ─────────────────────────────────────────────────

function getSavedCreds() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.ble.handler = null;
      reject(new Error("Timed out."));
    }, 5000);

    state.ble.handler = (msg) => {
      if (msg.type === RSP.WIFI_SAVED) {
        clearTimeout(timeout);
        state.ble.handler = null;
        if (msg.payload.length === 0) {
          resolve(null);
          return;
        }
        const text = new TextDecoder().decode(msg.payload);
        const sep = text.indexOf("\0");
        if (sep === -1) {
          resolve({ ssid: text, password: "" });
        } else {
          resolve({ ssid: text.slice(0, sep), password: text.slice(sep + 1) });
        }
      }
    };

    writeCmd(CMD.WIFI_GET_SAVED).catch((err) => {
      clearTimeout(timeout);
      state.ble.handler = null;
      reject(err);
    });
  });
}

// ── Time status ────────────────────────────────────────────────────

function getTimeStatus() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.ble.handler = null;
      reject(new Error("Timed out."));
    }, 5000);

    state.ble.handler = (msg) => {
      if (msg.type === RSP.TIME_STATUS) {
        clearTimeout(timeout);
        state.ble.handler = null;
        const synced = msg.payload[0] === 1;
        const dateStr = msg.payload.length > 1
          ? new TextDecoder().decode(msg.payload.slice(1))
          : "";
        debugLog("time status", { synced, dateStr });
        resolve({ synced, date: dateStr });
      } else if (msg.type === RSP.ERROR) {
        clearTimeout(timeout);
        state.ble.handler = null;
        const code = msg.payload.length > 1 ? msg.payload[1] : 0;
        reject(new Error(ERROR_NAME[code] || `Error 0x${code.toString(16)}`));
      }
    };

    writeCmd(CMD.GET_TIME_STATUS).catch((err) => {
      clearTimeout(timeout);
      state.ble.handler = null;
      reject(err);
    });
  });
}

// ── Date bitmap ────────────────────────────────────────────────────

function getDateBitmap() {
  return new Promise((resolve, reject) => {
    let width = 0;
    let height = 0;
    let totalExpected = null;
    let totalReceived = 0;
    const chunks = [];
    const pendingChunks = [];

    function fail(message) {
      debugLog("bitmap fail", {
        message,
        width,
        height,
        totalExpected,
        totalReceived,
        pendingChunks: pendingChunks.length,
        chunks: chunks.length,
      });
      clearTimeout(timeout);
      state.ble.handler = null;
      reject(new Error(message));
    }

    function processChunk(chunk) {
      chunks.push(chunk);
      totalReceived += chunk.length;
      debugLog("bitmap chunk", {
        chunkLength: chunk.length,
        totalReceived,
        totalExpected,
      });

      if (totalExpected !== null && totalReceived >= totalExpected) {
        clearTimeout(timeout);
        state.ble.handler = null;
        const bitmap = new Uint8Array(totalExpected);
        let offset = 0;
        for (const dataChunk of chunks) {
          const copyLen = Math.min(dataChunk.length, totalExpected - offset);
          if (copyLen <= 0) break;
          bitmap.set(dataChunk.slice(0, copyLen), offset);
          offset += copyLen;
        }
        debugLog("bitmap complete", { width, height, totalExpected, totalReceived });
        resolve({ width, height, data: bitmap });
      }
    }

    const timeout = setTimeout(() => {
      debugLog("bitmap timeout", {
        width,
        height,
        totalExpected,
        totalReceived,
        pendingChunks: pendingChunks.length,
        chunks: chunks.length,
      });
      state.ble.handler = null;
      reject(new Error("Bitmap transfer timed out."));
    }, 15000);

    state.ble.handler = (msg) => {
      if (msg.type === RSP.WIFI_STATUS) {
        handleWifiStatusMsg(msg.payload);
      } else if (msg.type === RSP.DATE_BITMAP_HEADER) {
        if (msg.payload.length < 4) {
          fail("Bitmap header was malformed.");
          return;
        }

        width = msg.payload[0] | (msg.payload[1] << 8);
        height = msg.payload[2] | (msg.payload[3] << 8);
        totalExpected = Math.ceil(width / 8) * height;
        debugLog("bitmap header", { width, height, totalExpected });

        if (!width || !height || !totalExpected) {
          fail("Bitmap header was empty.");
          return;
        }

        for (const chunk of pendingChunks) {
          processChunk(chunk);
        }
        pendingChunks.length = 0;
      } else if (msg.type === RSP.DATE_BITMAP_DATA) {
        if (totalExpected === null) {
          debugLog("bitmap chunk before header", { chunkLength: msg.payload.length });
          pendingChunks.push(msg.payload.slice());
        } else {
          processChunk(msg.payload);
        }
      } else if (msg.type === RSP.ERROR) {
        clearTimeout(timeout);
        state.ble.handler = null;
        const code = msg.payload.length > 1 ? msg.payload[1] : 0;
        reject(new Error(ERROR_NAME[code] || `Error 0x${code.toString(16)}`));
      }
    };

    writeCmd(CMD.GET_DATE_BITMAP).catch((err) => {
      debugLog("bitmap request failed", err);
      clearTimeout(timeout);
      state.ble.handler = null;
      reject(err);
    });
  });
}

function drawBitmapOnCanvas(canvas, bitmap) {
  const { width, height, data } = bitmap;
  if (!width || !height) return;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(width, height);
  const bytesPerRow = width / 8;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byteIdx = y * bytesPerRow + Math.floor(x / 8);
      const bitIdx = 7 - (x % 8);
      const pixel = (data[byteIdx] >> bitIdx) & 1;
      const i = (y * width + x) * 4;
      // 1 = black on white background
      const v = pixel ? 0 : 255;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
}

// ── UI ──────────────────────────────────────────────────────────────────

async function loadPreview() {
  if (!state.ble.connected || state.preview.loading) return;

  state.preview.loading = true;

  try {
    if (ui.timeStatus) ui.timeStatus.textContent = "Checking time...";
    const time = await getTimeStatus();
    if (ui.timeStatus) {
      ui.timeStatus.textContent = time.synced
        ? `Time synced: ${time.date}`
        : "Time not synced (waiting for date service)";
    }

    if (!time.synced) {
      if (ui.bitmapStatus) ui.bitmapStatus.textContent = "Waiting for time sync.";
      return;
    }

    if (ui.bitmapStatus) ui.bitmapStatus.textContent = "Loading bitmap...";
    const bitmap = await getDateBitmap();
    drawBitmapOnCanvas(ui.bitmapCanvas, bitmap);
    if (ui.bitmapStatus) {
      ui.bitmapStatus.textContent = `${bitmap.width}x${bitmap.height} (${bitmap.data.length} bytes)`;
    }
  } catch (err) {
    debugLog("preview load error", err);
    if (ui.bitmapStatus) ui.bitmapStatus.textContent = `Error: ${err.message}`;
  } finally {
    state.preview.loading = false;
  }
}

function updateWifiUI() {
  if (ui.wifiStatusText) {
    const name = WIFI_STATUS_NAME[state.wifi.status] || "Unknown";
    const ssid = state.wifi.ssid ? ` (${state.wifi.ssid})` : "";
    ui.wifiStatusText.textContent = `${name}${ssid}`;
  }
}

function updateUI() {
  if (!ui.connectBtn) return;

  ui.connectBtn.disabled = !state.ble.supported;
  ui.connectBtn.textContent = state.ble.connected ? "Disconnect" : "Connect";
  ui.connectBtn.className = state.ble.connected ? "secondary" : "primary";

  const connected = state.ble.connected;
  if (ui.scanBtn) ui.scanBtn.disabled = !connected || state.wifi.scanning;
  if (ui.wifiConnectBtn) ui.wifiConnectBtn.disabled = !connected;
  if (ui.clearBtn) ui.clearBtn.disabled = !connected;
  if (ui.loadSavedBtn) ui.loadSavedBtn.disabled = !connected;
  if (ui.reloadBitmapBtn) ui.reloadBitmapBtn.disabled = !connected;

  if (!state.ble.supported) {
    setBleStatus("Web Bluetooth is not available in this browser.");
  } else if (!state.ble.connected) {
    setBleStatus("Not connected.");
  }

  updateWifiUI();
}

function renderNetworkList(networks) {
  if (!ui.networkList) return;
  ui.networkList.innerHTML = "";

  const sorted = [...networks].sort((a, b) => b.rssi - a.rssi);
  for (const net of sorted) {
    const item = document.createElement("div");
    item.className = "network-item";
    item.innerHTML = `
      <span class="network-ssid">${net.ssid || "(hidden)"}</span>
      <span class="network-rssi">${net.rssi} dB</span>
    `;
    item.addEventListener("click", () => {
      if (ui.ssidInput) ui.ssidInput.value = net.ssid;
      document.querySelectorAll(".network-item.selected")
        .forEach((el) => el.classList.remove("selected"));
      item.classList.add("selected");
    });
    ui.networkList.appendChild(item);
  }
}

function renderApp(root) {
  root.innerHTML = `
    <main class="layout">
      <section class="card">
        <h2>Device</h2>
        <div class="button-row">
          <button id="connect-btn" class="primary" type="button">Connect</button>
        </div>
        <p id="ble-status" class="status">Not connected.</p>
      </section>

      <section class="card">
        <h2>WiFi</h2>
        <div class="button-row">
          <button id="scan-btn" type="button" disabled>Scan Networks</button>
        </div>
        <div id="network-list" class="network-list"></div>
        <div class="wifi-form">
          <input id="ssid-input" type="text" placeholder="SSID" />
          <input id="pass-input" type="password" placeholder="Password" />
          <button id="wifi-connect-btn" type="button" disabled>Connect WiFi</button>
        </div>
        <p id="wifi-status-text" class="status">Idle</p>
      </section>

      <section class="card">
        <h2>Label Preview</h2>
        <p id="time-status" class="status">Not connected.</p>
        <div style="margin-top: 0.75rem">
          <canvas id="bitmap-canvas" style="border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; image-rendering: pixelated; width: 100%; max-width: 300px;"></canvas>
        </div>
        <div class="button-row" style="margin-top: 0.75rem">
          <button id="reload-bitmap-btn" type="button" disabled>Reload</button>
        </div>
        <p id="bitmap-status" class="status"></p>
      </section>

      <details class="card">
        <summary>Debug</summary>
        <div class="button-row" style="margin-top: 0.75rem">
          <button id="load-saved-btn" type="button" disabled>Load Saved</button>
          <button id="clear-btn" type="button" disabled>Clear Credentials</button>
        </div>
        <p id="saved-creds" class="meta">No saved credentials loaded.</p>
      </details>
    </main>
  `;

  ui.connectBtn = root.querySelector("#connect-btn");
  ui.bleStatus = root.querySelector("#ble-status");
  ui.scanBtn = root.querySelector("#scan-btn");
  ui.networkList = root.querySelector("#network-list");
  ui.ssidInput = root.querySelector("#ssid-input");
  ui.passInput = root.querySelector("#pass-input");
  ui.wifiConnectBtn = root.querySelector("#wifi-connect-btn");
  ui.wifiStatusText = root.querySelector("#wifi-status-text");
  ui.loadSavedBtn = root.querySelector("#load-saved-btn");
  ui.clearBtn = root.querySelector("#clear-btn");
  ui.savedCreds = root.querySelector("#saved-creds");
  ui.timeStatus = root.querySelector("#time-status");
  ui.bitmapCanvas = root.querySelector("#bitmap-canvas");
  ui.reloadBitmapBtn = root.querySelector("#reload-bitmap-btn");
  ui.bitmapStatus = root.querySelector("#bitmap-status");

  ui.connectBtn.addEventListener("click", async () => {
    if (state.ble.connected) {
      await disconnectBle();
    } else {
      try {
        await connectBle();
      } catch (err) {
        setBleStatus(err.message);
      }
    }
    updateUI();
  });

  ui.scanBtn.addEventListener("click", async () => {
    setWifiStatus("Scanning...");
    try {
      const networks = await scanWifi();
      state.wifi.networks = networks;
      renderNetworkList(networks);
      setWifiStatus(`Found ${networks.length} network(s).`);
    } catch (err) {
      setWifiStatus(`Scan failed: ${err.message}`);
    }
  });

  ui.wifiConnectBtn.addEventListener("click", async () => {
    const ssid = ui.ssidInput.value.trim();
    const pass = ui.passInput.value;
    if (!ssid) {
      setWifiStatus("Enter an SSID.");
      return;
    }
    setWifiStatus(`Connecting to "${ssid}"...`);
    try {
      await connectWifi(ssid, pass);
      setWifiStatus(`Connected to "${ssid}".`);
      await loadPreview();
    } catch (err) {
      setWifiStatus(`WiFi failed: ${err.message}`);
    }
  });

  ui.loadSavedBtn.addEventListener("click", async () => {
    try {
      const creds = await getSavedCreds();
      if (creds) {
        ui.savedCreds.textContent = `SSID: ${creds.ssid} / Pass: ${creds.password}`;
      } else {
        ui.savedCreds.textContent = "No saved credentials.";
      }
    } catch (err) {
      ui.savedCreds.textContent = `Error: ${err.message}`;
    }
  });

  ui.clearBtn.addEventListener("click", async () => {
    try {
      await writeCmd(CMD.WIFI_CLEAR);
      ui.savedCreds.textContent = "Credentials cleared.";
      setWifiStatus("Idle");
    } catch (err) {
      ui.savedCreds.textContent = `Error: ${err.message}`;
    }
  });

  ui.reloadBitmapBtn.addEventListener("click", () => loadPreview());

  updateUI();
}

const root = document.querySelector("#app");

if (!root) {
  throw new Error("Missing #app root element");
}

renderApp(root);
