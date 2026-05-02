#pragma once

#include <stddef.h>
#include <stdint.h>

namespace date_label {

// ── Command types (SPA → ESP32, 0x01-0x7F) ──────────────────────────────
enum class CmdType : uint8_t {
  kWifiScan = 0x01,
  kWifiConnect = 0x02,
  kWifiGetStatus = 0x03,
  kWifiGetSaved = 0x04,
  kWifiClear = 0x05,
  kGetTimeStatus = 0x06,
  kGetDateBitmap = 0x07,
  kPrinterScan = 0x08,
  kPrinterBind = 0x09,
  kPrinterGetSaved = 0x0A,
  kPrintLabel = 0x0B,
};

// ── Response types (ESP32 → SPA, 0x80-0xFF) ──────────────────────────────
enum class RspType : uint8_t {
  kWifiScanResult = 0x81,
  kWifiScanDone = 0x82,
  kWifiStatus = 0x83,
  kWifiSaved = 0x84,
  kAck = 0x85,
  kError = 0x86,
  kTimeStatus = 0x87,
  kDateBitmapHeader = 0x88,
  kDateBitmapData = 0x89,
  kPrinterScanResult = 0x8A,
  kPrinterScanDone = 0x8B,
  kPrinterSaved = 0x8C,
};

enum class WifiStatus : uint8_t {
  kIdle = 0x00,
  kConnecting = 0x01,
  kConnected = 0x02,
  kFailed = 0x03,
  kSavedDisconnected = 0x04,
};

enum class ErrorCode : uint8_t {
  kUnknownCommand = 0x01,
  kMalformedPayload = 0x02,
  kScanInProgress = 0x03,
  kConnectInProgress = 0x04,
  kNvsFailure = 0x05,
  kTimeNotSynced = 0x06,
  kRenderFailed = 0x07,
  kOperationFailed = 0x08,
  kPrinterNotConfigured = 0x09,
  kPrintFailed = 0x0A,
};

struct MsgHeader {
  uint8_t type;
  uint8_t payloadLength;
};

constexpr size_t kMsgHeaderSize = 2;
constexpr size_t kMaxPayload = 242;
constexpr size_t kMaxMsgSize = 244;

bool ParseHeader(const uint8_t* data, size_t len, MsgHeader& header);

bool ParseWifiConnect(const uint8_t* payload, size_t len,
                      char* ssid, size_t ssidCap,
                      char* pass, size_t passCap);

bool ParsePrinterBind(const uint8_t* payload, size_t len,
                      char* address, size_t addressCap);

size_t EncodeScanResult(int8_t rssi, const char* ssid,
                        uint8_t* out, size_t cap);

size_t EncodeScanDone(uint8_t count, uint8_t* out, size_t cap);

size_t EncodeWifiStatus(WifiStatus status, const char* ssid,
                        uint8_t* out, size_t cap);

size_t EncodeSavedCreds(const char* ssid, const char* pass,
                        uint8_t* out, size_t cap);

size_t EncodeAck(uint8_t cmdType, uint8_t* out, size_t cap);

size_t EncodeError(uint8_t cmdType, ErrorCode code,
                   uint8_t* out, size_t cap);

size_t EncodeTimeStatus(bool synced, const char* dateStr,
                        uint8_t* out, size_t cap);

size_t EncodeBitmapHeader(uint16_t width, uint16_t height,
                          uint8_t* out, size_t cap);

size_t EncodeBitmapData(const uint8_t* data, size_t dataLen,
                        uint8_t* out, size_t cap);

size_t EncodePrinterScanResult(const char* name, const char* address,
                               uint8_t* out, size_t cap);

size_t EncodePrinterScanDone(uint8_t count, uint8_t* out, size_t cap);

size_t EncodePrinterSaved(const char* address, uint8_t* out, size_t cap);

}  // namespace date_label
