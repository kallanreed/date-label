#pragma once

#include <stddef.h>
#include <stdint.h>

#include <NimBLEDevice.h>

#include "wifi_manager.h"

namespace date_label {

class ConfigServerCallbacks;
class ConfigWriteCallbacks;

class BleConfigService {
 public:
  void Begin(WifiManager& wifi);
  void Poll();

 private:
  friend class ConfigServerCallbacks;
  friend class ConfigWriteCallbacks;

  void HandleConnect();
  void HandleDisconnect();
  void HandleWrite(const uint8_t* data, size_t length);
  void Notify(const uint8_t* data, size_t length);

  static void StaticNotify(const uint8_t* data, size_t length);

  WifiManager* wifi_ = nullptr;
  NimBLEServer* server_ = nullptr;
  NimBLECharacteristic* writeChar_ = nullptr;
  NimBLECharacteristic* notifyChar_ = nullptr;
  bool connected_ = false;

  static BleConfigService* instance_;
};

}  // namespace date_label
