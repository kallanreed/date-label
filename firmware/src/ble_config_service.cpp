#include "ble_config_service.h"

#include <Arduino.h>
#include <cctype>

#include "app_config.h"
#include "config_protocol.h"
#include "date_renderer.h"

namespace date_label {

BleConfigService* BleConfigService::instance_ = nullptr;
constexpr size_t kBitmapChunkSafetyLimit = 200;
constexpr unsigned long kBitmapChunkDelayMs = 30;
constexpr unsigned long kNotifyRetryDelayMs = 75;
constexpr unsigned long kIndicationAckTimeoutMs = 1500;
constexpr uint32_t kPrinterScanDurationMs = 10000;
constexpr size_t kPrinterAddressCap = 32;

bool ContainsIgnoreCase(const std::string& text, const char* needle) {
  if (needle == nullptr || needle[0] == '\0') return false;

  size_t match = 0;
  for (char ch : text) {
    if (std::tolower(static_cast<unsigned char>(ch)) ==
        std::tolower(static_cast<unsigned char>(needle[match]))) {
      match++;
      if (needle[match] == '\0') return true;
    } else {
      match = std::tolower(static_cast<unsigned char>(ch)) ==
                  std::tolower(static_cast<unsigned char>(needle[0]))
          ? 1
          : 0;
    }
  }

  return false;
}

// ── NimBLE callbacks ─────────────────────────────────────────────────────

class ConfigServerCallbacks : public NimBLEServerCallbacks {
 public:
  explicit ConfigServerCallbacks(BleConfigService& svc) : svc_(svc) {}

  void onConnect(NimBLEServer*, NimBLEConnInfo& connInfo) override {
    svc_.HandleConnect(connInfo);
  }

  void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int) override {
    svc_.HandleDisconnect();
  }

 private:
  BleConfigService& svc_;
};

class ConfigWriteCallbacks : public NimBLECharacteristicCallbacks {
 public:
  explicit ConfigWriteCallbacks(BleConfigService& svc) : svc_(svc) {}

  void onWrite(NimBLECharacteristic* chr, NimBLEConnInfo&) override {
    const std::string value = chr->getValue();
    svc_.HandleWrite(
        reinterpret_cast<const uint8_t*>(value.data()), value.size());
  }

 private:
  BleConfigService& svc_;
};

class ConfigNotifyCallbacks : public NimBLECharacteristicCallbacks {
 public:
  explicit ConfigNotifyCallbacks(BleConfigService& svc) : svc_(svc) {}

  void onStatus(NimBLECharacteristic*, NimBLEConnInfo&, int code) override {
    svc_.HandleNotifyStatus(code);
  }

 private:
  BleConfigService& svc_;
};

class PrinterScanCallbacks : public ::NimBLEScanCallbacks {
 public:
  explicit PrinterScanCallbacks(BleConfigService& svc) : svc_(svc) {}

  void onResult(const ::NimBLEAdvertisedDevice* advertisedDevice) override {
    svc_.HandlePrinterScanResult(advertisedDevice);
  }

  void onScanEnd(const ::NimBLEScanResults&, int reason) override {
    svc_.HandlePrinterScanEnd(reason);
  }

 private:
  BleConfigService& svc_;
};

// ── Public ───────────────────────────────────────────────────────────────

void BleConfigService::Begin(WifiManager& wifi) {
  wifi_ = &wifi;
  instance_ = this;

  NimBLEDevice::init(config::kBleDeviceName);
  NimBLEDevice::setMTU(247);

  server_ = NimBLEDevice::createServer();
  server_->setCallbacks(new ConfigServerCallbacks(*this));

  NimBLEService* service = server_->createService(config::kConfigServiceUuid);

  writeChar_ = service->createCharacteristic(
      config::kConfigWriteUuid,
      NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  writeChar_->setCallbacks(new ConfigWriteCallbacks(*this));

  notifyChar_ = service->createCharacteristic(
      config::kConfigNotifyUuid,
      NIMBLE_PROPERTY::NOTIFY | NIMBLE_PROPERTY::INDICATE);
  notifyChar_->setCallbacks(new ConfigNotifyCallbacks(*this));

  printerScan_ = NimBLEDevice::getScan();
  printerScan_->setActiveScan(true);
  printerScan_->setInterval(45);
  printerScan_->setWindow(30);
  printerScan_->setMaxResults(0);
  printerScan_->setDuplicateFilter(1);
  printerScanCallbacks_ = new PrinterScanCallbacks(*this);
  printerScan_->setScanCallbacks(printerScanCallbacks_, false);

  server_->start();

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->setName(config::kBleDeviceName);
  adv->addServiceUUID(config::kConfigServiceUuid);
  adv->enableScanResponse(true);
  adv->start();

  Serial.printf("BLE: advertising as \"%s\"\n", config::kBleDeviceName);
}

void BleConfigService::Poll() {
  if (wifi_ != nullptr) {
    wifi_->Poll(StaticNotify);
  }
  ContinuePrintJob();
  ContinueBitmapTransfer();
}

bool BleConfigService::RequestPrint() {
  if (printRequested_ || printInProgress_) {
    return false;
  }
  printRequested_ = true;
  return true;
}

bool BleConfigService::HasSavedPrinter() const {
  char address[kPrinterAddressCap] = {};
  return LoadPrinterAddress(address, sizeof(address));
}

// ── Private ──────────────────────────────────────────────────────────────

void BleConfigService::HandleConnect(const NimBLEConnInfo& connInfo) {
  connected_ = true;
  connHandle_ = connInfo.getConnHandle();
  peerMtu_ = connInfo.getMTU();
  Serial.printf("BLE: client connected (handle=%u mtu=%u)\n", connHandle_, peerMtu_);
}

void BleConfigService::HandleDisconnect() {
  connected_ = false;
  connHandle_ = BLE_HS_CONN_HANDLE_NONE;
  peerMtu_ = 23;
  if (printerScan_ != nullptr && printerScan_->isScanning()) {
    printerScan_->stop();
  }
  printerScanActive_ = false;
  printerScanCount_ = 0;
  printerSeenAddresses_.clear();
  ResetBitmapTransfer();
  Serial.println("BLE: client disconnected");
  NimBLEDevice::getAdvertising()->start();
}

void BleConfigService::HandleWrite(const uint8_t* data, size_t length) {
  MsgHeader header;
  if (!ParseHeader(data, length, header)) {
    uint8_t buf[kMaxMsgSize];
    size_t len = EncodeError(0, ErrorCode::kMalformedPayload, buf, sizeof(buf));
    if (len > 0) Notify(buf, len);
    return;
  }

  const uint8_t* payload = data + kMsgHeaderSize;
  uint8_t buf[kMaxMsgSize];

  switch (static_cast<CmdType>(header.type)) {
    case CmdType::kWifiScan:
      wifi_->StartScan(StaticNotify);
      break;

    case CmdType::kWifiConnect: {
      char ssid[33] = {};
      char pass[65] = {};
      if (!ParseWifiConnect(payload, header.payloadLength,
                            ssid, sizeof(ssid), pass, sizeof(pass))) {
        size_t len = EncodeError(header.type, ErrorCode::kMalformedPayload,
                                 buf, sizeof(buf));
        if (len > 0) Notify(buf, len);
        return;
      }
      wifi_->StartConnect(ssid, pass, StaticNotify);
      break;
    }

    case CmdType::kWifiGetStatus: {
      size_t len = EncodeWifiStatus(
          wifi_->status(),
          wifi_->status() == WifiStatus::kConnected ? wifi_->ssid() : nullptr,
          buf, sizeof(buf));
      if (len > 0) Notify(buf, len);
      break;
    }

    case CmdType::kWifiGetSaved: {
      char ssid[33] = {};
      char pass[65] = {};
      if (wifi_->LoadSaved(ssid, sizeof(ssid), pass, sizeof(pass))) {
        size_t len = EncodeSavedCreds(ssid, pass, buf, sizeof(buf));
        if (len > 0) Notify(buf, len);
      } else {
        size_t len = EncodeSavedCreds(nullptr, nullptr, buf, sizeof(buf));
        if (len > 0) Notify(buf, len);
      }
      break;
    }

    case CmdType::kWifiClear:
      wifi_->Clear(StaticNotify);
      break;

    case CmdType::kGetTimeStatus: {
      char dateBuf[11] = {};
      bool synced = wifi_->GetDateString(dateBuf, sizeof(dateBuf));
      size_t len = EncodeTimeStatus(synced, synced ? dateBuf : nullptr,
                                     buf, sizeof(buf));
      if (len > 0) Notify(buf, len);
      break;
    }

    case CmdType::kGetDateBitmap: {
      ResetBitmapTransfer();
      char dateBuf[11] = {};
      if (!wifi_->GetDateString(dateBuf, sizeof(dateBuf))) {
        size_t len = EncodeError(header.type, ErrorCode::kTimeNotSynced,
                                 buf, sizeof(buf));
        if (len > 0) Notify(buf, len);
        break;
      }

      uint16_t bmpW, bmpH;
      bitmapData_ = RenderDateBitmap(dateBuf, bmpW, bmpH);
      if (bitmapData_ == nullptr) {
        size_t len = EncodeError(header.type, ErrorCode::kRenderFailed,
                                  buf, sizeof(buf));
        if (len > 0) Notify(buf, len);
        break;
      }

      bitmapWidth_ = bmpW;
      bitmapHeight_ = bmpH;
      bitmapTotalBytes_ = (bmpW / 8) * bmpH;
      if (server_ != nullptr && connHandle_ != BLE_HS_CONN_HANDLE_NONE) {
        uint16_t currentPeerMtu = server_->getPeerMTU(connHandle_);
        if (currentPeerMtu > 0) {
          peerMtu_ = currentPeerMtu;
        }
      }
      size_t maxChunkPayload = kMaxPayload;
      if (peerMtu_ > 5) {
        size_t peerPayload = peerMtu_ - 5;  // ATT MTU minus ATT(3) and protocol(2) headers.
        if (peerPayload < maxChunkPayload) {
          maxChunkPayload = peerPayload;
        }
      }
      if (maxChunkPayload > kBitmapChunkSafetyLimit) {
        maxChunkPayload = kBitmapChunkSafetyLimit;
      }
      bitmapChunkPayload_ = maxChunkPayload;
      bitmapOffset_ = 0;
      bitmapTransferActive_ = true;
      bitmapHeaderPending_ = true;
      bitmapAwaitingAck_ = false;
      bitmapAckDeadlineMs_ = 0;
      bitmapNextSendMs_ = 0;
      Serial.printf("BLE: bitmap transfer queued mtu=%u chunk=%u total=%u\n",
                    peerMtu_, bitmapChunkPayload_, bitmapTotalBytes_);
      break;
    }

    case CmdType::kPrinterScan:
      StartPrinterScan();
      break;

    case CmdType::kPrinterBind: {
      char address[kPrinterAddressCap] = {};
      if (!ParsePrinterBind(payload, header.payloadLength, address, sizeof(address))) {
        size_t len = EncodeError(header.type, ErrorCode::kMalformedPayload,
                                 buf, sizeof(buf));
        if (len > 0) Notify(buf, len);
        return;
      }

      if (!SavePrinterAddress(address)) {
        size_t len = EncodeError(header.type, ErrorCode::kNvsFailure,
                                 buf, sizeof(buf));
        if (len > 0) Notify(buf, len);
        return;
      }

      size_t len = EncodeAck(header.type, buf, sizeof(buf));
      if (len > 0) Notify(buf, len);
      break;
    }

    case CmdType::kPrinterGetSaved: {
      char address[kPrinterAddressCap] = {};
      bool haveSaved = LoadPrinterAddress(address, sizeof(address));
      size_t len = EncodePrinterSaved(haveSaved ? address : nullptr, buf, sizeof(buf));
      if (len > 0) Notify(buf, len);
      break;
    }

    case CmdType::kPrintLabel:
      if (!RequestPrint()) {
        size_t len = EncodeError(header.type, ErrorCode::kOperationFailed,
                                 buf, sizeof(buf));
        if (len > 0) Notify(buf, len);
      }
      break;

    default: {
      size_t len = EncodeError(header.type, ErrorCode::kUnknownCommand,
                               buf, sizeof(buf));
      if (len > 0) Notify(buf, len);
      break;
    }
  }
}

void BleConfigService::HandleNotifyStatus(int code) {
  if (!bitmapTransferActive_ || !bitmapAwaitingAck_) return;

  if (code == BLE_HS_EDONE) {
    bitmapAwaitingAck_ = false;
    bitmapAckDeadlineMs_ = 0;
    bitmapNextSendMs_ = millis() + kBitmapChunkDelayMs;
    return;
  }

  Serial.printf("BLE: indicate status error=%d at offset=%u\n", code, bitmapOffset_);
  ResetBitmapTransfer();
}

void BleConfigService::ContinueBitmapTransfer() {
  if (!bitmapTransferActive_ || !connected_) return;
  if (bitmapAwaitingAck_) {
    if (bitmapAckDeadlineMs_ != 0 && millis() >= bitmapAckDeadlineMs_) {
      Serial.printf("BLE: indication wait timed out at offset=%u\n", bitmapOffset_);
      ResetBitmapTransfer();
    }
    return;
  }
  if (bitmapNextSendMs_ != 0 && millis() < bitmapNextSendMs_) return;

  uint8_t buf[kMaxMsgSize];
  size_t len = 0;

  if (bitmapHeaderPending_) {
    len = EncodeBitmapHeader(bitmapWidth_, bitmapHeight_, buf, sizeof(buf));
    if (len == 0) {
      Serial.println("BLE: failed to encode bitmap header");
      ResetBitmapTransfer();
      return;
    }
    if (!Notify(buf, len, true)) {
      bitmapNextSendMs_ = millis() + kNotifyRetryDelayMs;
      return;
    }
    bitmapHeaderPending_ = false;
    bitmapAwaitingAck_ = true;
    bitmapAckDeadlineMs_ = millis() + kIndicationAckTimeoutMs;
    return;
  }

  if (bitmapOffset_ >= bitmapTotalBytes_) {
    Serial.printf("BLE: sent bitmap %ux%u (%u bytes)\n",
                  bitmapWidth_, bitmapHeight_, bitmapTotalBytes_);
    ResetBitmapTransfer();
    return;
  }

  size_t chunk = bitmapTotalBytes_ - bitmapOffset_;
  if (chunk > bitmapChunkPayload_) chunk = bitmapChunkPayload_;
  len = EncodeBitmapData(bitmapData_ + bitmapOffset_, chunk, buf, sizeof(buf));
  if (len == 0) {
    Serial.printf("BLE: failed to encode bitmap chunk at offset=%u size=%u\n",
                  bitmapOffset_, chunk);
    ResetBitmapTransfer();
    return;
  }
  if (!Notify(buf, len, true)) {
    bitmapNextSendMs_ = millis() + kNotifyRetryDelayMs;
    return;
  }
  bitmapOffset_ += chunk;
  bitmapAwaitingAck_ = true;
  bitmapAckDeadlineMs_ = millis() + kIndicationAckTimeoutMs;
}

void BleConfigService::ContinuePrintJob() {
  if (!printRequested_ || wifi_ == nullptr) return;

  printRequested_ = false;
  printInProgress_ = true;
  const PrinterManager::PrintResult result = printerManager_.PrintCurrentDate(*wifi_);
  printInProgress_ = false;

  uint8_t buf[kMaxMsgSize];
  size_t len = 0;
  switch (result) {
    case PrinterManager::PrintResult::kOk:
      len = EncodeAck(static_cast<uint8_t>(CmdType::kPrintLabel), buf, sizeof(buf));
      break;
    case PrinterManager::PrintResult::kPrinterNotConfigured:
      len = EncodeError(static_cast<uint8_t>(CmdType::kPrintLabel),
                        ErrorCode::kPrinterNotConfigured, buf, sizeof(buf));
      break;
    case PrinterManager::PrintResult::kTimeNotSynced:
      len = EncodeError(static_cast<uint8_t>(CmdType::kPrintLabel),
                        ErrorCode::kTimeNotSynced, buf, sizeof(buf));
      break;
    case PrinterManager::PrintResult::kRenderFailed:
      len = EncodeError(static_cast<uint8_t>(CmdType::kPrintLabel),
                        ErrorCode::kRenderFailed, buf, sizeof(buf));
      break;
    case PrinterManager::PrintResult::kConnectionFailed:
    case PrinterManager::PrintResult::kServiceMissing:
    case PrinterManager::PrintResult::kWriteFailed:
      len = EncodeError(static_cast<uint8_t>(CmdType::kPrintLabel),
                        ErrorCode::kPrintFailed, buf, sizeof(buf));
      break;
  }

  if (len > 0) Notify(buf, len);
}

void BleConfigService::StartPrinterScan() {
  if (printerScan_ == nullptr) {
    uint8_t buf[kMaxMsgSize];
    size_t len = EncodeError(static_cast<uint8_t>(CmdType::kPrinterScan),
                             ErrorCode::kOperationFailed, buf, sizeof(buf));
    if (len > 0) Notify(buf, len);
    return;
  }

  if (printerScanActive_ || printerScan_->isScanning()) {
    uint8_t buf[kMaxMsgSize];
    size_t len = EncodeError(static_cast<uint8_t>(CmdType::kPrinterScan),
                             ErrorCode::kScanInProgress, buf, sizeof(buf));
    if (len > 0) Notify(buf, len);
    return;
  }

  printerScanCount_ = 0;
  printerSeenAddresses_.clear();
  printerScan_->clearResults();
  printerScanActive_ = true;

  Serial.println("BLE: starting printer scan...");
  if (!printerScan_->start(kPrinterScanDurationMs, false, true)) {
    printerScanActive_ = false;
    uint8_t buf[kMaxMsgSize];
    size_t len = EncodeError(static_cast<uint8_t>(CmdType::kPrinterScan),
                             ErrorCode::kOperationFailed, buf, sizeof(buf));
    if (len > 0) Notify(buf, len);
  }
}

void BleConfigService::HandlePrinterScanResult(const ::NimBLEAdvertisedDevice* device) {
  if (!printerScanActive_ || device == nullptr) return;

  const ::NimBLEUUID printerServiceUuid(config::kPrinterServiceUuid);
  const bool isPrinterService = device->isAdvertisingService(printerServiceUuid);
  const std::string name = device->getName();
  if (!isPrinterService && !ContainsIgnoreCase(name, "D12")) return;

  const std::string address = device->getAddress().toString();
  for (const std::string& seenAddress : printerSeenAddresses_) {
    if (seenAddress == address) return;
  }

  printerSeenAddresses_.push_back(address);
  if (printerScanCount_ < 255) {
    printerScanCount_++;
  }

  const char* printerName = name.empty() ? "D12" : name.c_str();
  uint8_t buf[kMaxMsgSize];
  size_t len = EncodePrinterScanResult(printerName, address.c_str(), buf, sizeof(buf));
  if (len > 0) Notify(buf, len);
}

void BleConfigService::HandlePrinterScanEnd(int reason) {
  if (!printerScanActive_) return;

  printerScanActive_ = false;
  Serial.printf("BLE: printer scan complete reason=%d results=%u\n",
                reason, printerScanCount_);

  uint8_t buf[kMaxMsgSize];
  size_t len = EncodePrinterScanDone(printerScanCount_, buf, sizeof(buf));
  if (len > 0) Notify(buf, len);
  if (printerScan_ != nullptr) {
    printerScan_->clearResults();
  }
}

bool BleConfigService::LoadPrinterAddress(char* address, size_t cap) const {
  return printerManager_.LoadAddress(address, cap);
}

bool BleConfigService::SavePrinterAddress(const char* address) {
  const bool saved = printerManager_.SaveAddress(address);
  if (saved) {
    Serial.printf("BLE: saved printer address %s\n", address);
  }
  return saved;
}

void BleConfigService::ResetBitmapTransfer() {
  if (bitmapData_ != nullptr) {
    delete[] bitmapData_;
    bitmapData_ = nullptr;
  }
  bitmapWidth_ = 0;
  bitmapHeight_ = 0;
  bitmapTotalBytes_ = 0;
  bitmapOffset_ = 0;
  bitmapChunkPayload_ = 0;
  bitmapTransferActive_ = false;
  bitmapHeaderPending_ = false;
  bitmapAwaitingAck_ = false;
  bitmapAckDeadlineMs_ = 0;
  bitmapNextSendMs_ = 0;
}

bool BleConfigService::Notify(const uint8_t* data, size_t length, bool requireAck) {
  if (notifyChar_ == nullptr || !connected_ || connHandle_ == BLE_HS_CONN_HANDLE_NONE) return false;
  if (server_ != nullptr) {
    uint16_t currentPeerMtu = server_->getPeerMTU(connHandle_);
    if (currentPeerMtu > 0) {
      peerMtu_ = currentPeerMtu;
    }
  }
  bool ok = requireAck
    ? notifyChar_->indicate(data, length, connHandle_)
    : notifyChar_->notify(data, length, connHandle_);
  if (!ok) {
    Serial.printf("BLE: %s failed (handle=%u len=%u)\n",
                  requireAck ? "indicate" : "notify", connHandle_, length);
  }
  return ok;
}

void BleConfigService::StaticNotify(const uint8_t* data, size_t length) {
  if (instance_ != nullptr) {
    instance_->Notify(data, length);
  }
}

}  // namespace date_label
