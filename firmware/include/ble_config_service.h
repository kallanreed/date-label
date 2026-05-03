#pragma once

#include <stddef.h>
#include <stdint.h>

#include <string>
#include <vector>

#include <NimBLEDevice.h>

#include "printer_manager.h"
#include "wifi_manager.h"

namespace date_label {

class ConfigServerCallbacks;
class ConfigWriteCallbacks;
class ConfigNotifyCallbacks;
class PrinterScanCallbacks;

class BleConfigService {
 public:
  void Begin(WifiManager& wifi);
  void Poll();
  bool RequestPrint();
  bool HasSavedPrinter() const;
  bool IsPrinting() const { return printRequested_ || printInProgress_; }

 private:
  friend class ConfigServerCallbacks;
  friend class ConfigWriteCallbacks;
  friend class ConfigNotifyCallbacks;
  friend class PrinterScanCallbacks;

  void HandleConnect(const NimBLEConnInfo& connInfo);
  void HandleDisconnect();
  void HandleWrite(const uint8_t* data, size_t length);
  void HandleNotifyStatus(int code);
  bool Notify(const uint8_t* data, size_t length, bool requireAck = false);
  void ContinueBitmapTransfer();
  void ResetBitmapTransfer();
  void StartPrinterScan();
  void HandlePrinterScanResult(const ::NimBLEAdvertisedDevice* device);
  void HandlePrinterScanEnd(int reason);
  bool LoadPrinterAddress(char* address, size_t cap) const;
  bool SavePrinterAddress(const char* address);
  void ContinuePrintJob();

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
  ::NimBLEScan* printerScan_ = nullptr;
  ::NimBLEScanCallbacks* printerScanCallbacks_ = nullptr;
  bool printerScanActive_ = false;
  uint8_t printerScanCount_ = 0;
  std::vector<std::string> printerSeenAddresses_;
  PrinterManager printerManager_;
  bool printRequested_ = false;
  bool printInProgress_ = false;

  static BleConfigService* instance_;
};

}  // namespace date_label
