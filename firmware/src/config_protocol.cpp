#include "config_protocol.h"

#include <string.h>

namespace date_label {

bool ParseHeader(const uint8_t* data, size_t len, MsgHeader& header) {
  if (data == nullptr || len < kMsgHeaderSize) return false;
  header.type = data[0];
  header.payloadLength = data[1];
  return len >= kMsgHeaderSize + header.payloadLength;
}

bool ParseWifiConnect(const uint8_t* payload, size_t len,
                      char* ssid, size_t ssidCap,
                      char* pass, size_t passCap) {
  // Payload format: SSID\0password
  // Find the null separator.
  const uint8_t* sep = static_cast<const uint8_t*>(
      memchr(payload, '\0', len));
  if (sep == nullptr) return false;

  size_t ssidLen = sep - payload;
  size_t passLen = len - ssidLen - 1;

  if (ssidLen == 0 || ssidLen >= ssidCap) return false;
  if (passLen >= passCap) return false;

  memcpy(ssid, payload, ssidLen);
  ssid[ssidLen] = '\0';
  memcpy(pass, sep + 1, passLen);
  pass[passLen] = '\0';
  return true;
}

bool ParsePrinterBind(const uint8_t* payload, size_t len,
                      char* address, size_t addressCap) {
  if (payload == nullptr || len == 0 || len >= addressCap) return false;
  memcpy(address, payload, len);
  address[len] = '\0';
  return true;
}

bool ParseTimeZoneConfig(const uint8_t* payload, size_t len,
                         int16_t& offsetMinutes, bool& useDst) {
  if (payload == nullptr || len != 3) return false;

  offsetMinutes = static_cast<int16_t>(payload[0] | (payload[1] << 8));
  if (offsetMinutes < -720 || offsetMinutes > 840) return false;

  if (payload[2] > 1) return false;
  useDst = payload[2] == 1;
  return true;
}

// ── Encode helpers ───────────────────────────────────────────────────────

static size_t WriteHeader(uint8_t type, uint8_t payloadLen,
                          uint8_t* out, size_t cap) {
  if (cap < kMsgHeaderSize + payloadLen) return 0;
  out[0] = type;
  out[1] = payloadLen;
  return kMsgHeaderSize;
}

size_t EncodeScanResult(int8_t rssi, const char* ssid,
                        uint8_t* out, size_t cap) {
  size_t ssidLen = strlen(ssid);
  uint8_t payloadLen = static_cast<uint8_t>(1 + ssidLen);
  size_t total = kMsgHeaderSize + payloadLen;
  if (cap < total || payloadLen > kMaxPayload) return 0;

  WriteHeader(static_cast<uint8_t>(RspType::kWifiScanResult), payloadLen,
              out, cap);
  out[2] = static_cast<uint8_t>(rssi);
  memcpy(out + 3, ssid, ssidLen);
  return total;
}

size_t EncodeScanDone(uint8_t count, uint8_t* out, size_t cap) {
  constexpr uint8_t payloadLen = 1;
  constexpr size_t total = kMsgHeaderSize + payloadLen;
  if (cap < total) return 0;

  WriteHeader(static_cast<uint8_t>(RspType::kWifiScanDone), payloadLen,
              out, cap);
  out[2] = count;
  return total;
}

size_t EncodeWifiStatus(WifiStatus status, const char* ssid,
                        uint8_t* out, size_t cap) {
  size_t ssidLen = ssid != nullptr ? strlen(ssid) : 0;
  uint8_t payloadLen = static_cast<uint8_t>(1 + ssidLen);
  size_t total = kMsgHeaderSize + payloadLen;
  if (cap < total || payloadLen > kMaxPayload) return 0;

  WriteHeader(static_cast<uint8_t>(RspType::kWifiStatus), payloadLen,
              out, cap);
  out[2] = static_cast<uint8_t>(status);
  if (ssidLen > 0) {
    memcpy(out + 3, ssid, ssidLen);
  }
  return total;
}

size_t EncodeSavedCreds(const char* ssid, const char* pass,
                        uint8_t* out, size_t cap) {
  if (ssid == nullptr || ssid[0] == '\0') {
    // No saved creds — send empty payload.
    if (cap < kMsgHeaderSize) return 0;
    WriteHeader(static_cast<uint8_t>(RspType::kWifiSaved), 0, out, cap);
    return kMsgHeaderSize;
  }

  size_t ssidLen = strlen(ssid);
  size_t passLen = pass != nullptr ? strlen(pass) : 0;
  uint8_t payloadLen = static_cast<uint8_t>(ssidLen + 1 + passLen);
  size_t total = kMsgHeaderSize + payloadLen;
  if (cap < total || payloadLen > kMaxPayload) return 0;

  WriteHeader(static_cast<uint8_t>(RspType::kWifiSaved), payloadLen,
              out, cap);
  memcpy(out + 2, ssid, ssidLen);
  out[2 + ssidLen] = '\0';
  memcpy(out + 2 + ssidLen + 1, pass, passLen);
  return total;
}

size_t EncodeAck(uint8_t cmdType, uint8_t* out, size_t cap) {
  constexpr uint8_t payloadLen = 1;
  constexpr size_t total = kMsgHeaderSize + payloadLen;
  if (cap < total) return 0;

  WriteHeader(static_cast<uint8_t>(RspType::kAck), payloadLen, out, cap);
  out[2] = cmdType;
  return total;
}

size_t EncodeError(uint8_t cmdType, ErrorCode code,
                   uint8_t* out, size_t cap) {
  constexpr uint8_t payloadLen = 2;
  constexpr size_t total = kMsgHeaderSize + payloadLen;
  if (cap < total) return 0;

  WriteHeader(static_cast<uint8_t>(RspType::kError), payloadLen, out, cap);
  out[2] = cmdType;
  out[3] = static_cast<uint8_t>(code);
  return total;
}

size_t EncodeTimeStatus(bool synced, const char* dateStr,
                        uint8_t* out, size_t cap) {
  size_t dateLen = (synced && dateStr) ? strlen(dateStr) : 0;
  uint8_t payloadLen = static_cast<uint8_t>(1 + dateLen);
  size_t total = kMsgHeaderSize + payloadLen;
  if (cap < total || payloadLen > kMaxPayload) return 0;

  WriteHeader(static_cast<uint8_t>(RspType::kTimeStatus), payloadLen, out, cap);
  out[2] = synced ? 1 : 0;
  if (dateLen > 0) memcpy(out + 3, dateStr, dateLen);
  return total;
}

size_t EncodeBitmapHeader(uint16_t width, uint16_t height,
                          uint8_t* out, size_t cap) {
  constexpr uint8_t payloadLen = 4;
  constexpr size_t total = kMsgHeaderSize + payloadLen;
  if (cap < total) return 0;

  WriteHeader(static_cast<uint8_t>(RspType::kDateBitmapHeader), payloadLen,
              out, cap);
  out[2] = width & 0xFF;
  out[3] = (width >> 8) & 0xFF;
  out[4] = height & 0xFF;
  out[5] = (height >> 8) & 0xFF;
  return total;
}

size_t EncodeBitmapData(const uint8_t* data, size_t dataLen,
                        uint8_t* out, size_t cap) {
  if (dataLen > kMaxPayload) return 0;
  uint8_t payloadLen = static_cast<uint8_t>(dataLen);
  size_t total = kMsgHeaderSize + payloadLen;
  if (cap < total) return 0;

  WriteHeader(static_cast<uint8_t>(RspType::kDateBitmapData), payloadLen,
              out, cap);
  memcpy(out + kMsgHeaderSize, data, dataLen);
  return total;
}

size_t EncodePrinterScanResult(const char* name, const char* address,
                               uint8_t* out, size_t cap) {
  if (name == nullptr || address == nullptr) return 0;

  size_t nameLen = strlen(name);
  size_t addressLen = strlen(address);
  uint8_t payloadLen = static_cast<uint8_t>(nameLen + 1 + addressLen);
  size_t total = kMsgHeaderSize + payloadLen;
  if (cap < total || payloadLen > kMaxPayload) return 0;

  WriteHeader(static_cast<uint8_t>(RspType::kPrinterScanResult), payloadLen,
              out, cap);
  memcpy(out + 2, name, nameLen);
  out[2 + nameLen] = '\0';
  memcpy(out + 3 + nameLen, address, addressLen);
  return total;
}

size_t EncodePrinterScanDone(uint8_t count, uint8_t* out, size_t cap) {
  constexpr uint8_t payloadLen = 1;
  constexpr size_t total = kMsgHeaderSize + payloadLen;
  if (cap < total) return 0;

  WriteHeader(static_cast<uint8_t>(RspType::kPrinterScanDone), payloadLen,
              out, cap);
  out[2] = count;
  return total;
}

size_t EncodePrinterSaved(const char* address, uint8_t* out, size_t cap) {
  if (address == nullptr || address[0] == '\0') {
    if (cap < kMsgHeaderSize) return 0;
    WriteHeader(static_cast<uint8_t>(RspType::kPrinterSaved), 0, out, cap);
    return kMsgHeaderSize;
  }

  size_t addressLen = strlen(address);
  uint8_t payloadLen = static_cast<uint8_t>(addressLen);
  size_t total = kMsgHeaderSize + payloadLen;
  if (cap < total || payloadLen > kMaxPayload) return 0;

  WriteHeader(static_cast<uint8_t>(RspType::kPrinterSaved), payloadLen, out, cap);
  memcpy(out + 2, address, addressLen);
  return total;
}

size_t EncodeTimeZoneSaved(bool configured, int16_t offsetMinutes, bool useDst,
                           uint8_t* out, size_t cap) {
  if (!configured) {
    if (cap < kMsgHeaderSize) return 0;
    WriteHeader(static_cast<uint8_t>(RspType::kTimeZoneSaved), 0, out, cap);
    return kMsgHeaderSize;
  }

  constexpr uint8_t payloadLen = 3;
  constexpr size_t total = kMsgHeaderSize + payloadLen;
  if (cap < total) return 0;

  WriteHeader(static_cast<uint8_t>(RspType::kTimeZoneSaved), payloadLen, out, cap);
  out[2] = static_cast<uint8_t>(offsetMinutes & 0xFF);
  out[3] = static_cast<uint8_t>((offsetMinutes >> 8) & 0xFF);
  out[4] = useDst ? 1 : 0;
  return total;
}

}  // namespace date_label
