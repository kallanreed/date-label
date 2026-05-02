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
  PRINTER_SCAN: 0x08,
  PRINTER_BIND: 0x09,
  PRINTER_GET_SAVED: 0x0A,
  PRINT_LABEL: 0x0B,
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
  PRINTER_SCAN_RESULT: 0x8A,
  PRINTER_SCAN_DONE: 0x8B,
  PRINTER_SAVED: 0x8C,
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
  0x08: "Operation failed",
  0x09: "No printer bound",
  0x0A: "Print failed",
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
  printer: {
    scanning: false,
    devices: [],
    selectedAddress: "",
    boundAddress: "",
  },
  preview: {
    loading: false,
    printing: false,
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

function encodeText(value) {
  return new TextEncoder().encode(value);
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
  state.wifi.networks = [];
  state.wifi.scanning = false;
  state.printer.devices = [];
  state.printer.scanning = false;
  state.printer.selectedAddress = "";
  state.printer.boundAddress = "";
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
  await getSavedPrinter();
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

function getSavedPrinter() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.ble.handler = null;
      reject(new Error("Timed out."));
    }, 5000);

    state.ble.handler = (msg) => {
      if (msg.type === RSP.PRINTER_SAVED) {
        clearTimeout(timeout);
        state.ble.handler = null;
        state.printer.boundAddress = msg.payload.length
          ? new TextDecoder().decode(msg.payload)
          : "";
        updatePrinterUI();
        resolve(state.printer.boundAddress);
      } else if (msg.type === RSP.ERROR) {
        clearTimeout(timeout);
        state.ble.handler = null;
        const code = msg.payload.length > 1 ? msg.payload[1] : 0;
        reject(new Error(ERROR_NAME[code] || `Error 0x${code.toString(16)}`));
      } else if (msg.type === RSP.WIFI_STATUS) {
        handleWifiStatusMsg(msg.payload);
      }
    };

    writeCmd(CMD.PRINTER_GET_SAVED).catch((err) => {
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

// ── Printer setup ────────────────────────────────────────────────────────

function scanPrinters() {
  return new Promise((resolve, reject) => {
    const devices = [];
    const timeout = setTimeout(() => {
      state.ble.handler = null;
      state.printer.scanning = false;
      updateUI();
      reject(new Error("Scan timed out."));
    }, SCAN_TIMEOUT_MS);

    state.ble.handler = (msg) => {
      if (msg.type === RSP.PRINTER_SCAN_RESULT) {
        const text = new TextDecoder().decode(msg.payload);
        const sep = text.indexOf("\0");
        if (sep !== -1) {
          devices.push({
            name: text.slice(0, sep) || "D12",
            address: text.slice(sep + 1),
          });
        }
      } else if (msg.type === RSP.PRINTER_SCAN_DONE) {
        clearTimeout(timeout);
        state.ble.handler = null;
        state.printer.scanning = false;
        updateUI();
        resolve(devices);
      } else if (msg.type === RSP.ERROR) {
        clearTimeout(timeout);
        state.ble.handler = null;
        state.printer.scanning = false;
        updateUI();
        const code = msg.payload.length > 1 ? msg.payload[1] : 0;
        reject(new Error(ERROR_NAME[code] || `Error 0x${code.toString(16)}`));
      } else if (msg.type === RSP.WIFI_STATUS) {
        handleWifiStatusMsg(msg.payload);
      }
    };

    state.printer.scanning = true;
    updateUI();
    writeCmd(CMD.PRINTER_SCAN).catch((err) => {
      clearTimeout(timeout);
      state.ble.handler = null;
      state.printer.scanning = false;
      updateUI();
      reject(err);
    });
  });
}

function bindPrinter(address) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.ble.handler = null;
      reject(new Error("Bind timed out."));
    }, 5000);

    state.ble.handler = (msg) => {
      if (msg.type === RSP.ACK && msg.payload[0] === CMD.PRINTER_BIND) {
        clearTimeout(timeout);
        state.ble.handler = null;
        resolve();
      } else if (msg.type === RSP.ERROR) {
        clearTimeout(timeout);
        state.ble.handler = null;
        const code = msg.payload.length > 1 ? msg.payload[1] : 0;
        reject(new Error(ERROR_NAME[code] || `Error 0x${code.toString(16)}`));
      } else if (msg.type === RSP.WIFI_STATUS) {
        handleWifiStatusMsg(msg.payload);
      }
    };

    writeCmd(CMD.PRINTER_BIND, encodeText(address)).catch((err) => {
      clearTimeout(timeout);
      state.ble.handler = null;
      reject(err);
    });
  });
}

function printLabel() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.ble.handler = null;
      reject(new Error("Print timed out."));
    }, 30000);

    state.ble.handler = (msg) => {
      if (msg.type === RSP.ACK && msg.payload[0] === CMD.PRINT_LABEL) {
        clearTimeout(timeout);
        state.ble.handler = null;
        resolve();
      } else if (msg.type === RSP.ERROR) {
        clearTimeout(timeout);
        state.ble.handler = null;
        const code = msg.payload.length > 1 ? msg.payload[1] : 0;
        reject(new Error(ERROR_NAME[code] || `Error 0x${code.toString(16)}`));
      } else if (msg.type === RSP.WIFI_STATUS) {
        handleWifiStatusMsg(msg.payload);
      }
    };

    writeCmd(CMD.PRINT_LABEL).catch((err) => {
      clearTimeout(timeout);
      state.ble.handler = null;
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
  updateUI();

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
    updateUI();
  }
}

function updateWifiUI() {
  if (ui.wifiStatusText) {
    const name = WIFI_STATUS_NAME[state.wifi.status] || "Unknown";
    const ssid = state.wifi.ssid ? ` (${state.wifi.ssid})` : "";
    ui.wifiStatusText.textContent = `${name}${ssid}`;
  }
}

function updatePrinterUI() {
  if (ui.printerStatus) {
    if (state.printer.scanning) {
      ui.printerStatus.textContent = "Scanning...";
    } else if (state.printer.boundAddress) {
      ui.printerStatus.textContent = `Saved printer: ${state.printer.boundAddress}`;
    } else {
      ui.printerStatus.textContent = "No printer bound.";
    }
  }

  if (ui.printerSelection) {
    ui.printerSelection.textContent = state.printer.selectedAddress
      ? `Selected: ${state.printer.selectedAddress}`
      : "Select a printer from the scan results.";
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
  if (ui.printerScanBtn) ui.printerScanBtn.disabled = !connected || state.printer.scanning;
  if (ui.printerBindBtn) {
    ui.printerBindBtn.disabled =
      !connected || state.printer.scanning || !state.printer.selectedAddress;
  }
  if (ui.clearBtn) ui.clearBtn.disabled = !connected;
  if (ui.loadSavedBtn) ui.loadSavedBtn.disabled = !connected;
  if (ui.reloadBitmapBtn) ui.reloadBitmapBtn.disabled = !connected;
  if (ui.printBtn) {
    ui.printBtn.disabled =
      !connected ||
      state.preview.loading ||
      state.preview.printing ||
      !state.printer.boundAddress;
  }

  if (!state.ble.supported) {
    setBleStatus("Web Bluetooth is not available in this browser.");
  } else if (!state.ble.connected) {
    setBleStatus("Not connected.");
  }

  updateWifiUI();
  updatePrinterUI();
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
      document.querySelectorAll("#network-list .network-item.selected")
        .forEach((el) => el.classList.remove("selected"));
      item.classList.add("selected");
    });
    ui.networkList.appendChild(item);
  }
}

function renderPrinterList(devices) {
  if (!ui.printerList) return;
  ui.printerList.innerHTML = "";

  for (const printer of devices) {
    const item = document.createElement("div");
    item.className = "network-item";
    item.innerHTML = `
      <span class="network-ssid">${printer.name || "D12"}</span>
      <span class="network-rssi">${printer.address}</span>
    `;
    item.addEventListener("click", () => {
      state.printer.selectedAddress = printer.address;
      document.querySelectorAll("#printer-list .network-item.selected")
        .forEach((el) => el.classList.remove("selected"));
      item.classList.add("selected");
      updateUI();
    });
    if (printer.address === state.printer.selectedAddress) {
      item.classList.add("selected");
    }
    ui.printerList.appendChild(item);
  }
}

function renderApp(root) {
  root.innerHTML = `
    <main class="layout">
      <header class="page-header">
        <p class="eyebrow">Date Label Setup</p>
        <h1>Configure and test the printer flow</h1>
        <p class="page-copy">Connect to the ESP32, join WiFi, bind the D12, preview the date label, and test printing from one screen.</p>
      </header>

      <div class="card-grid">
        <section class="card">
          <div class="card-header">
            <h2>Device</h2>
            <p class="section-copy">Start by connecting to the ESP32 config service over Web Bluetooth.</p>
          </div>
        <div class="button-row">
          <button id="connect-btn" class="primary" type="button">Connect Device</button>
        </div>
        <p id="ble-status" class="status">Not connected.</p>
        </section>

        <section class="card">
          <div class="card-header">
            <h2>WiFi</h2>
            <p class="section-copy">Scan for nearby networks, then save credentials so the device can sync the current date.</p>
          </div>
        <div class="button-row">
          <button id="scan-btn" type="button" disabled>Scan Networks</button>
        </div>
        <div id="network-list" class="network-list"></div>
        <div class="wifi-form">
          <input id="ssid-input" type="text" placeholder="SSID" />
          <input id="pass-input" type="password" placeholder="Password" />
          <button id="wifi-connect-btn" type="button" disabled>Save WiFi</button>
        </div>
        <p id="wifi-status-text" class="status">Idle</p>
        </section>

        <section class="card">
          <div class="card-header">
            <h2>Printer</h2>
            <p class="section-copy">Find the D12 over BLE, then store its address so the ESP32 can reconnect for each print job.</p>
          </div>
        <div class="button-row">
          <button id="printer-scan-btn" type="button" disabled>Scan Printers</button>
          <button id="printer-bind-btn" type="button" disabled>Save Printer</button>
        </div>
        <div id="printer-list" class="network-list"></div>
        <p id="printer-selection" class="meta">Select a printer from the scan results.</p>
        <p id="printer-status" class="status">No printer bound.</p>
        </section>
      </div>

      <section class="card">
        <div class="card-header">
          <h2>Label Preview</h2>
          <p class="section-copy">This preview is shown at the bitmap&apos;s actual size. Printing here uses the same ESP32 path as the eventual hardware button.</p>
        </div>
        <p id="time-status" class="status">Not connected.</p>
        <div class="preview-row">
          <div class="preview-shell">
            <canvas id="bitmap-canvas" class="preview-canvas"></canvas>
          </div>
          <div class="preview-actions">
            <button id="reload-bitmap-btn" type="button" disabled>Refresh Preview</button>
            <button id="print-btn" type="button" disabled>Print Label</button>
          </div>
        </div>
        <p id="bitmap-status" class="status"></p>
      </section>

      <details class="card">
        <summary>Advanced</summary>
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
  ui.printerScanBtn = root.querySelector("#printer-scan-btn");
  ui.printerBindBtn = root.querySelector("#printer-bind-btn");
  ui.printerList = root.querySelector("#printer-list");
  ui.printerSelection = root.querySelector("#printer-selection");
  ui.printerStatus = root.querySelector("#printer-status");
  ui.loadSavedBtn = root.querySelector("#load-saved-btn");
  ui.clearBtn = root.querySelector("#clear-btn");
  ui.savedCreds = root.querySelector("#saved-creds");
  ui.timeStatus = root.querySelector("#time-status");
  ui.bitmapCanvas = root.querySelector("#bitmap-canvas");
  ui.reloadBitmapBtn = root.querySelector("#reload-bitmap-btn");
  ui.printBtn = root.querySelector("#print-btn");
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

  ui.printerScanBtn.addEventListener("click", async () => {
    state.printer.selectedAddress = "";
    updatePrinterUI();
    try {
      const devices = await scanPrinters();
      state.printer.devices = devices;
      if (state.printer.boundAddress) {
        const saved = devices.find((device) => device.address === state.printer.boundAddress);
        if (saved) {
          state.printer.selectedAddress = saved.address;
        }
      }
      renderPrinterList(devices);
      if (ui.printerStatus) {
        ui.printerStatus.textContent = `Found ${devices.length} printer(s).`;
      }
      updateUI();
    } catch (err) {
      if (ui.printerStatus) {
        ui.printerStatus.textContent = `Scan failed: ${err.message}`;
      }
    }
  });

  ui.printerBindBtn.addEventListener("click", async () => {
    if (!state.printer.selectedAddress) {
      updatePrinterUI();
      return;
    }

    if (ui.printerStatus) {
      ui.printerStatus.textContent = `Binding ${state.printer.selectedAddress}...`;
    }

    try {
      await bindPrinter(state.printer.selectedAddress);
      await getSavedPrinter();
      if (ui.printerStatus) {
        ui.printerStatus.textContent = `Bound printer: ${state.printer.boundAddress}`;
      }
    } catch (err) {
      if (ui.printerStatus) {
        ui.printerStatus.textContent = `Bind failed: ${err.message}`;
      }
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

  ui.printBtn.addEventListener("click", async () => {
    state.preview.printing = true;
    updateUI();
    if (ui.bitmapStatus) {
      ui.bitmapStatus.textContent = "Printing...";
    }

    try {
      await printLabel();
      if (ui.bitmapStatus) {
        ui.bitmapStatus.textContent = "Print job sent.";
      }
    } catch (err) {
      if (ui.bitmapStatus) {
        ui.bitmapStatus.textContent = `Print failed: ${err.message}`;
      }
    } finally {
      state.preview.printing = false;
      updateUI();
    }
  });

  updateUI();
}

const root = document.querySelector("#app");

if (!root) {
  throw new Error("Missing #app root element");
}

renderApp(root);
