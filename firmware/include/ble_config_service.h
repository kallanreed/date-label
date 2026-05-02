#pragma once

#include <stddef.h>
#include <stdint.h>

#include <NimBLEDevice.h>

#include "wifi_manager.h"

namespace date_label {

class ConfigServerCallbacks;
class ConfigWriteCallbacks;
class ConfigNotifyCallbacks;

class BleConfigService {
 public:
  void Begin(WifiManager& wifi);
  void Poll();

 private:
  friend class ConfigServerCallbacks;
  friend class ConfigWriteCallbacks;
  friend class ConfigNotifyCallbacks;

  void HandleConnect(const NimBLEConnInfo& connInfo);
  void HandleDisconnect();
  void HandleWrite(const uint8_t* data, size_t length);
  void HandleNotifyStatus(int code);
  bool Notify(const uint8_t* data, size_t length, bool requireAck = false);
  void ContinueBitmapTransfer();
  void ResetBitmapTransfer();

  static void StaticNotify(const uint8_t* data, size_t length);

  WifiManager* wifi_ = nullptr;
  NimBLEServer* server_ = nullptr;
  NimBLECharacteristic* writeChar_ = nullptr;
  NimBLECharacteristic* notifyChar_ = nullptr;
  bool connected_ = false;
  uint16_t connHandle_ = BLE_HS_CONN_HANDLE_NONE;
  uint16_t peerMtu_ = 23;
  uint8_t* bitmapData_ = nullptr;
  uint16_t bitmapWidth_ = 0;
  uint16_t bitmapHeight_ = 0;
  size_t bitmapTotalBytes_ = 0;
  size_t bitmapOffset_ = 0;
  size_t bitmapChunkPayload_ = 0;
  bool bitmapTransferActive_ = false;
  bool bitmapHeaderPending_ = false;
  bool bitmapAwaitingAck_ = false;
  unsigned long bitmapAckDeadlineMs_ = 0;
  unsigned long bitmapNextSendMs_ = 0;

  static BleConfigService* instance_;
};

}  // namespace date_label
