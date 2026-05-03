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
  TIMEZONE_SET: 0x0C,
  TIMEZONE_GET_SAVED: 0x0D,
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
  TIMEZONE_SAVED: 0x8D,
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
    savedSsid: "",
    networks: [],
    scanning: false,
  },
  printer: {
    scanning: false,
    devices: [],
    selectedAddress: "",
    boundAddress: "",
  },
  device: {
    timeSynced: false,
    time: "",
  },
  timeZone: {
    configured: false,
    offsetMinutes: 0,
    useDst: false,
  },
  config: {
    editing: null,
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

function encodeTimeZoneConfig(offsetMinutes, useDst) {
  const payload = new Uint8Array(3);
  const view = new DataView(payload.buffer);
  view.setInt16(0, offsetMinutes, true);
  payload[2] = useDst ? 1 : 0;
  return payload;
}

function formatUtcOffset(offsetMinutes, useDst = false) {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const totalMinutes = Math.abs(offsetMinutes);
  const hours = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const minutes = String(totalMinutes % 60).padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}${useDst ? " + DST" : ""}`;
}

function parseUtcOffset(input) {
  const normalized = input.trim().toUpperCase().replace(/^UTC/, "");
  const match = normalized.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return null;

  const hours = Number(match[2]);
  const minutes = match[3] ? Number(match[3]) : 0;
  if (Number.isNaN(hours) || Number.isNaN(minutes) || minutes >= 60) {
    return null;
  }

  const total = hours * 60 + minutes;
  if (total > 14 * 60) return null;
  return match[1] === "-" ? -total : total;
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
  state.wifi.savedSsid = "";
  state.printer.devices = [];
  state.printer.scanning = false;
  state.printer.selectedAddress = "";
  state.printer.boundAddress = "";
  state.device.timeSynced = false;
  state.device.time = "";
  state.timeZone.configured = false;
  state.timeZone.offsetMinutes = 0;
  state.timeZone.useDst = false;
  state.config.editing = null;
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
  await loadSavedWifi();
  await getSavedPrinter();
  await getSavedTimeZone();
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

function getSavedTimeZone() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.ble.handler = null;
      reject(new Error("Timed out."));
    }, 5000);

    state.ble.handler = (msg) => {
      if (msg.type === RSP.TIMEZONE_SAVED) {
        clearTimeout(timeout);
        state.ble.handler = null;
        if (msg.payload.length === 3) {
          const view = new DataView(
            msg.payload.buffer,
            msg.payload.byteOffset,
            msg.payload.byteLength
          );
          state.timeZone.configured = true;
          state.timeZone.offsetMinutes = view.getInt16(0, true);
          state.timeZone.useDst = msg.payload[2] === 1;
        } else {
          state.timeZone.configured = false;
          state.timeZone.offsetMinutes = 0;
          state.timeZone.useDst = false;
        }
        updateConfigUI();
        resolve({ ...state.timeZone });
      } else if (msg.type === RSP.ERROR) {
        clearTimeout(timeout);
        state.ble.handler = null;
        const code = msg.payload.length > 1 ? msg.payload[1] : 0;
        reject(new Error(ERROR_NAME[code] || `Error 0x${code.toString(16)}`));
      } else if (msg.type === RSP.WIFI_STATUS) {
        handleWifiStatusMsg(msg.payload);
      }
    };

    writeCmd(CMD.TIMEZONE_GET_SAVED).catch((err) => {
      clearTimeout(timeout);
      state.ble.handler = null;
      reject(err);
    });
  });
}

async function loadSavedWifi() {
  const creds = await getSavedCreds();
  state.wifi.savedSsid = creds?.ssid || "";
  updateUI();
  return state.wifi.savedSsid;
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

function saveTimeZone(offsetMinutes, useDst) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.ble.handler = null;
      reject(new Error("Save timed out."));
    }, 5000);

    state.ble.handler = (msg) => {
      if (msg.type === RSP.ACK && msg.payload[0] === CMD.TIMEZONE_SET) {
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

    writeCmd(CMD.TIMEZONE_SET, encodeTimeZoneConfig(offsetMinutes, useDst)).catch((err) => {
      clearTimeout(timeout);
      state.ble.handler = null;
      reject(err);
    });
  });
}

function toggleConfigEditor(section) {
  state.config.editing = state.config.editing === section ? null : section;

  if (state.config.editing === "wifi" && ui.ssidInput) {
    ui.ssidInput.value = state.wifi.savedSsid || state.wifi.ssid || "";
    if (ui.passInput) ui.passInput.value = "";
  }

  if (state.config.editing === "timezone") {
    if (ui.timeZoneInput) {
      ui.timeZoneInput.value = state.timeZone.configured
        ? formatUtcOffset(state.timeZone.offsetMinutes).replace("UTC", "")
        : "";
    }
    if (ui.timeZoneDstInput) {
      ui.timeZoneDstInput.checked = state.timeZone.useDst;
    }
  }

  updateUI();
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
    const time = await getTimeStatus();
    state.device.timeSynced = time.synced;
    state.device.time = time.date;
    updateStatusUI();

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
    state.device.timeSynced = false;
    state.device.time = "";
    updateStatusUI();
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

function updateStatusUI() {
  if (ui.statusWifiValue) {
    if (state.wifi.status === 0x02 && state.wifi.ssid) {
      ui.statusWifiValue.textContent = `Connected to ${state.wifi.ssid}`;
    } else if (state.wifi.savedSsid) {
      ui.statusWifiValue.textContent = `Saved: ${state.wifi.savedSsid}`;
    } else {
      ui.statusWifiValue.textContent = "Not configured";
    }
  }

  if (ui.statusTimeValue) {
    if (!state.timeZone.configured) {
      ui.statusTimeValue.textContent = "Timezone not configured";
    } else {
      ui.statusTimeValue.textContent = state.device.timeSynced && state.device.time
        ? state.device.time
        : "Waiting for sync";
    }
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

function updateConfigUI() {
  if (ui.configWifiValue) {
    ui.configWifiValue.textContent = state.wifi.savedSsid || "Not configured";
  }

  if (ui.configPrinterValue) {
    ui.configPrinterValue.textContent = state.printer.boundAddress || "Not configured";
  }

  if (ui.configTimeZoneValue) {
    ui.configTimeZoneValue.textContent = state.timeZone.configured
      ? formatUtcOffset(state.timeZone.offsetMinutes, state.timeZone.useDst)
      : "Not configured";
  }

  if (ui.editWifiBtn) {
    ui.editWifiBtn.textContent = state.config.editing === "wifi" ? "Done" : "Edit";
    ui.editWifiBtn.disabled = !state.ble.connected;
  }

  if (ui.editPrinterBtn) {
    ui.editPrinterBtn.textContent = state.config.editing === "printer" ? "Done" : "Edit";
    ui.editPrinterBtn.disabled = !state.ble.connected;
  }

  if (ui.editTimeZoneBtn) {
    ui.editTimeZoneBtn.textContent = state.config.editing === "timezone" ? "Done" : "Edit";
    ui.editTimeZoneBtn.disabled = !state.ble.connected;
  }

  if (ui.wifiEditor) {
    ui.wifiEditor.hidden = state.config.editing !== "wifi";
  }

  if (ui.printerEditor) {
    ui.printerEditor.hidden = state.config.editing !== "printer";
  }

  if (ui.timeZoneEditor) {
    ui.timeZoneEditor.hidden = state.config.editing !== "timezone";
  }

  if (ui.timeZoneStatus) {
    ui.timeZoneStatus.textContent = state.timeZone.configured
      ? `Saved: ${formatUtcOffset(state.timeZone.offsetMinutes, state.timeZone.useDst)}`
      : "Timezone not configured.";
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
  if (ui.timeZoneSaveBtn) ui.timeZoneSaveBtn.disabled = !connected;
  if (ui.clearConfigBtn) ui.clearConfigBtn.disabled = !connected;
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
  updateStatusUI();
  updatePrinterUI();
  updateConfigUI();
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
      <section class="card compact-card">
        <div class="card-header">
          <h2>Device</h2>
        </div>
        <div class="button-row">
          <button id="connect-btn" class="primary" type="button">Connect Device</button>
        </div>
        <p id="ble-status" class="status">Not connected.</p>
      </section>

      <section class="card compact-card">
        <div class="card-header">
          <h2>Status</h2>
        </div>
        <table class="info-table">
          <tbody>
            <tr>
              <th scope="row">WiFi</th>
              <td id="status-wifi-value">Not configured</td>
            </tr>
            <tr>
              <th scope="row">Device Time</th>
              <td id="status-time-value">Waiting for sync</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Config</h2>
        </div>
        <table class="info-table config-table">
          <tbody>
            <tr>
              <th scope="row">WiFi SSID</th>
              <td id="config-wifi-value">Not configured</td>
              <td class="table-action">
                <button id="edit-wifi-btn" class="secondary" type="button" disabled>Edit</button>
              </td>
            </tr>
            <tr>
              <th scope="row">Printer</th>
              <td id="config-printer-value">Not configured</td>
              <td class="table-action">
                <button id="edit-printer-btn" class="secondary" type="button" disabled>Edit</button>
              </td>
            </tr>
            <tr>
              <th scope="row">Time Zone</th>
              <td id="config-timezone-value">Not configured</td>
              <td class="table-action">
                <button id="edit-timezone-btn" class="secondary" type="button" disabled>Edit</button>
              </td>
            </tr>
          </tbody>
        </table>

        <div id="wifi-editor" class="config-editor" hidden>
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
        </div>

        <div id="printer-editor" class="config-editor" hidden>
          <div class="button-row">
            <button id="printer-scan-btn" type="button" disabled>Scan Printers</button>
            <button id="printer-bind-btn" type="button" disabled>Save Printer</button>
          </div>
          <div id="printer-list" class="network-list"></div>
          <p id="printer-selection" class="meta">Select a printer from the scan results.</p>
          <p id="printer-status" class="status">No printer bound.</p>
        </div>

        <div id="timezone-editor" class="config-editor" hidden>
          <div class="wifi-form">
            <input id="timezone-input" type="text" placeholder="-07:00" />
            <button id="timezone-save-btn" type="button" disabled>Save Time Zone</button>
          </div>
          <label class="settings-row checkbox-row">
            <input id="timezone-dst-input" type="checkbox" />
            <span>Use NIST DST flag</span>
          </label>
          <p id="timezone-status" class="status">Timezone not configured.</p>
        </div>

        <div class="button-row section-actions">
          <button id="clear-config-btn" class="secondary" type="button" disabled>Clear Config</button>
        </div>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Label Preview</h2>
        </div>
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
    </main>
  `;

  ui.connectBtn = root.querySelector("#connect-btn");
  ui.bleStatus = root.querySelector("#ble-status");
  ui.statusWifiValue = root.querySelector("#status-wifi-value");
  ui.statusTimeValue = root.querySelector("#status-time-value");
  ui.configWifiValue = root.querySelector("#config-wifi-value");
  ui.configPrinterValue = root.querySelector("#config-printer-value");
  ui.configTimeZoneValue = root.querySelector("#config-timezone-value");
  ui.editWifiBtn = root.querySelector("#edit-wifi-btn");
  ui.editPrinterBtn = root.querySelector("#edit-printer-btn");
  ui.editTimeZoneBtn = root.querySelector("#edit-timezone-btn");
  ui.scanBtn = root.querySelector("#scan-btn");
  ui.networkList = root.querySelector("#network-list");
  ui.ssidInput = root.querySelector("#ssid-input");
  ui.passInput = root.querySelector("#pass-input");
  ui.wifiConnectBtn = root.querySelector("#wifi-connect-btn");
  ui.wifiStatusText = root.querySelector("#wifi-status-text");
  ui.wifiEditor = root.querySelector("#wifi-editor");
  ui.printerScanBtn = root.querySelector("#printer-scan-btn");
  ui.printerBindBtn = root.querySelector("#printer-bind-btn");
  ui.printerList = root.querySelector("#printer-list");
  ui.printerSelection = root.querySelector("#printer-selection");
  ui.printerStatus = root.querySelector("#printer-status");
  ui.printerEditor = root.querySelector("#printer-editor");
  ui.timeZoneInput = root.querySelector("#timezone-input");
  ui.timeZoneDstInput = root.querySelector("#timezone-dst-input");
  ui.timeZoneSaveBtn = root.querySelector("#timezone-save-btn");
  ui.timeZoneStatus = root.querySelector("#timezone-status");
  ui.timeZoneEditor = root.querySelector("#timezone-editor");
  ui.clearConfigBtn = root.querySelector("#clear-config-btn");
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

  ui.editWifiBtn.addEventListener("click", () => toggleConfigEditor("wifi"));
  ui.editPrinterBtn.addEventListener("click", () => toggleConfigEditor("printer"));
  ui.editTimeZoneBtn.addEventListener("click", () => toggleConfigEditor("timezone"));

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
      state.wifi.savedSsid = ssid;
      state.config.editing = null;
      setWifiStatus(`Connected to "${ssid}".`);
      await loadPreview();
      updateUI();
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
      state.config.editing = null;
      if (ui.printerStatus) {
        ui.printerStatus.textContent = `Bound printer: ${state.printer.boundAddress}`;
      }
      updateUI();
    } catch (err) {
      if (ui.printerStatus) {
        ui.printerStatus.textContent = `Bind failed: ${err.message}`;
      }
    }
  });

  ui.clearConfigBtn.addEventListener("click", async () => {
    try {
      await writeCmd(CMD.WIFI_CLEAR);
      state.wifi.savedSsid = "";
      state.wifi.ssid = "";
      state.wifi.networks = [];
      state.wifi.status = 0x00;
      state.printer.boundAddress = "";
      state.printer.selectedAddress = "";
      state.printer.devices = [];
      state.device.timeSynced = false;
      state.device.time = "";
      state.timeZone.configured = false;
      state.timeZone.offsetMinutes = 0;
      state.timeZone.useDst = false;
      state.config.editing = null;
      renderNetworkList([]);
      renderPrinterList([]);
      setWifiStatus("Idle");
      if (ui.printerStatus) ui.printerStatus.textContent = "No printer bound.";
      if (ui.timeZoneStatus) ui.timeZoneStatus.textContent = "Timezone not configured.";
      if (ui.bitmapStatus) ui.bitmapStatus.textContent = "Config cleared.";
      ui.bitmapCanvas.width = 0;
      ui.bitmapCanvas.height = 0;
      updateUI();
    } catch (err) {
      if (ui.bitmapStatus) ui.bitmapStatus.textContent = `Clear failed: ${err.message}`;
    }
  });

  ui.reloadBitmapBtn.addEventListener("click", () => loadPreview());

  ui.timeZoneSaveBtn.addEventListener("click", async () => {
    const offsetMinutes = parseUtcOffset(ui.timeZoneInput.value);
    const useDst = ui.timeZoneDstInput.checked;
    if (offsetMinutes === null) {
      if (ui.timeZoneStatus) ui.timeZoneStatus.textContent = "Enter an offset like -07:00.";
      return;
    }

    if (ui.timeZoneStatus) {
      ui.timeZoneStatus.textContent = `Saving ${formatUtcOffset(offsetMinutes, useDst)}...`;
    }

    try {
      await saveTimeZone(offsetMinutes, useDst);
      state.timeZone.configured = true;
      state.timeZone.offsetMinutes = offsetMinutes;
      state.timeZone.useDst = useDst;
      state.config.editing = null;
      await loadPreview();
      updateUI();
    } catch (err) {
      if (ui.timeZoneStatus) {
        ui.timeZoneStatus.textContent = `Save failed: ${err.message}`;
      }
    }
  });

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
