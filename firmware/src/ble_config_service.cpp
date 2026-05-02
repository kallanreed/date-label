#include "ble_config_service.h"

#include <Arduino.h>

#include "app_config.h"
#include "config_protocol.h"
#include "date_renderer.h"

namespace date_label {

BleConfigService* BleConfigService::instance_ = nullptr;

// ── NimBLE callbacks ─────────────────────────────────────────────────────

class ConfigServerCallbacks : public NimBLEServerCallbacks {
 public:
  explicit ConfigServerCallbacks(BleConfigService& svc) : svc_(svc) {}

  void onConnect(NimBLEServer*, NimBLEConnInfo&) override {
    svc_.HandleConnect();
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
      NIMBLE_PROPERTY::NOTIFY);

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
}

// ── Private ──────────────────────────────────────────────────────────────

void BleConfigService::HandleConnect() {
  connected_ = true;
  Serial.println("BLE: client connected");
}

void BleConfigService::HandleDisconnect() {
  connected_ = false;
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
      char dateBuf[11] = {};
      if (!wifi_->GetDateString(dateBuf, sizeof(dateBuf))) {
        size_t len = EncodeError(header.type, ErrorCode::kTimeNotSynced,
                                 buf, sizeof(buf));
        if (len > 0) Notify(buf, len);
        break;
      }

      uint16_t bmpW, bmpH;
      uint8_t* bmpData = RenderDateBitmap(dateBuf, bmpW, bmpH);
      if (bmpData == nullptr) {
        size_t len = EncodeError(header.type, ErrorCode::kRenderFailed,
                                 buf, sizeof(buf));
        if (len > 0) Notify(buf, len);
        break;
      }

      // Send header.
      size_t len = EncodeBitmapHeader(bmpW, bmpH, buf, sizeof(buf));
      if (len > 0) Notify(buf, len);
      delay(20);

      // Send data in chunks.
      size_t totalBytes = (bmpW / 8) * bmpH;
      size_t offset = 0;
      while (offset < totalBytes) {
        size_t chunk = totalBytes - offset;
        if (chunk > kMaxPayload) chunk = kMaxPayload;
        len = EncodeBitmapData(bmpData + offset, chunk, buf, sizeof(buf));
        if (len > 0) Notify(buf, len);
        offset += chunk;
        delay(20);
      }

      delete[] bmpData;
      Serial.printf("BLE: sent bitmap %ux%u (%u bytes)\n", bmpW, bmpH, totalBytes);
      break;
    }

    default: {
      size_t len = EncodeError(header.type, ErrorCode::kUnknownCommand,
                               buf, sizeof(buf));
      if (len > 0) Notify(buf, len);
      break;
    }
  }
}

void BleConfigService::Notify(const uint8_t* data, size_t length) {
  if (notifyChar_ == nullptr || !connected_) return;
  notifyChar_->setValue(data, length);
  notifyChar_->notify();
}

void BleConfigService::StaticNotify(const uint8_t* data, size_t length) {
  if (instance_ != nullptr) {
    instance_->Notify(data, length);
  }
}

}  // namespace date_label
