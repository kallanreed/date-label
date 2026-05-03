#include "printer_manager.h"

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <Preferences.h>

#include <memory>
#include <string>

#include "app_config.h"
#include "date_renderer.h"
#include "wifi_manager.h"

namespace date_label {

namespace {

constexpr uint8_t kCmdEnable[] = {0x10, 0xFF, 0xFE, 0x01};
constexpr uint8_t kCmdWakeup[] = {0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                                  0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
constexpr uint8_t kCmdLocation[] = {0x1B, 0x61, 0x01};
constexpr uint8_t kCmdDensity[] = {0x10, 0xFF, 0x10, 0x00, config::kPrinterDensity};
constexpr uint8_t kCmdPaperType[] = {0x10, 0xFF, 0x10, 0x03, config::kPrinterPaperTypeGap};
constexpr uint8_t kCmdLineDot[] = {0x1B, 0x4A, 0x0A};
constexpr uint8_t kCmdPosition[] = {0x1D, 0x0C};
constexpr uint8_t kCmdStopJob[] = {0x10, 0xFF, 0xFE, 0x45};

constexpr size_t kPrinterAddressCap = 32;

size_t BuildPrintPayload(const uint8_t* bitmap, uint16_t width, uint16_t height,
                         uint8_t*& outPayload) {
  const uint16_t widthBytes = width / 8;
  const size_t bitmapLen = static_cast<size_t>(widthBytes) * height;
  const size_t totalLen = sizeof(kCmdEnable) + sizeof(kCmdWakeup) + sizeof(kCmdLocation) +
                          sizeof(kCmdDensity) + sizeof(kCmdPaperType) + 8 + bitmapLen +
                          sizeof(kCmdLineDot) + sizeof(kCmdPosition) + sizeof(kCmdStopJob);

  outPayload = new uint8_t[totalLen];
  size_t offset = 0;

  auto append = [&](const uint8_t* src, size_t len) {
    memcpy(outPayload + offset, src, len);
    offset += len;
  };

  append(kCmdEnable, sizeof(kCmdEnable));
  append(kCmdWakeup, sizeof(kCmdWakeup));
  append(kCmdLocation, sizeof(kCmdLocation));
  append(kCmdDensity, sizeof(kCmdDensity));
  append(kCmdPaperType, sizeof(kCmdPaperType));

  outPayload[offset++] = 0x1D;
  outPayload[offset++] = 0x76;
  outPayload[offset++] = 0x30;
  outPayload[offset++] = 0x00;
  outPayload[offset++] = widthBytes & 0xFF;
  outPayload[offset++] = (widthBytes >> 8) & 0xFF;
  outPayload[offset++] = height & 0xFF;
  outPayload[offset++] = (height >> 8) & 0xFF;

  append(bitmap, bitmapLen);
  append(kCmdLineDot, sizeof(kCmdLineDot));
  append(kCmdPosition, sizeof(kCmdPosition));
  append(kCmdStopJob, sizeof(kCmdStopJob));

  return totalLen;
}

}  // namespace

bool PrinterManager::SaveAddress(const char* address) {
  if (address == nullptr || address[0] == '\0') return false;

  Preferences prefs;
  prefs.begin(config::kNvsNamespace, false);
  const size_t written = prefs.putString(config::kNvsKeyPrinterAddr, address);
  prefs.end();
  return written > 0;
}

bool PrinterManager::LoadAddress(char* address, size_t cap) const {
  if (address == nullptr || cap == 0) return false;

  Preferences prefs;
  prefs.begin(config::kNvsNamespace, true);
  String saved = prefs.getString(config::kNvsKeyPrinterAddr, "");
  prefs.end();

  if (saved.length() == 0 || saved.length() >= cap) return false;
  strncpy(address, saved.c_str(), cap - 1);
  address[cap - 1] = '\0';
  return true;
}

PrinterManager::PrintResult PrinterManager::PrintCurrentDate(const WifiManager& wifi) {
  char address[kPrinterAddressCap] = {};
  if (!LoadAddress(address, sizeof(address))) {
    return PrintResult::kPrinterNotConfigured;
  }

  char dateBuf[11] = {};
  if (!wifi.GetDateString(dateBuf, sizeof(dateBuf))) {
    return PrintResult::kTimeNotSynced;
  }

  uint16_t width = 0;
  uint16_t height = 0;
  std::unique_ptr<uint8_t[]> bitmap(RenderDateBitmap(dateBuf, width, height));
  if (!bitmap) {
    return PrintResult::kRenderFailed;
  }

  uint8_t* rawPayload = nullptr;
  const size_t payloadLen = BuildPrintPayload(bitmap.get(), width, height, rawPayload);
  std::unique_ptr<uint8_t[]> payload(rawPayload);

  if (TryPrintWithAddressType(address, BLE_ADDR_PUBLIC, payload.get(), payloadLen) ||
      TryPrintWithAddressType(address, BLE_ADDR_RANDOM, payload.get(), payloadLen)) {
    return PrintResult::kOk;
  }

  return PrintResult::kConnectionFailed;
}

bool PrinterManager::TryPrintWithAddressType(const char* address, uint8_t addrType,
                                             const uint8_t* payload,
                                             size_t payloadLen) const {
  NimBLEAddress printerAddress(std::string(address), addrType);
  NimBLEClient* client = NimBLEDevice::createClient(printerAddress);
  if (client == nullptr) return false;

  client->setConnectTimeout(5000);
  bool ok = false;

  if (client->connect(printerAddress, true, false, true)) {
    NimBLERemoteService* service = client->getService(config::kPrinterServiceUuid);
    if (service != nullptr) {
      NimBLERemoteCharacteristic* writeChar =
          service->getCharacteristic(config::kPrinterWriteUuid);
      if (writeChar != nullptr) {
        ok = WritePayload(writeChar, payload, payloadLen, client->getMTU());
      }
    }
  }

  if (client->isConnected()) {
    client->disconnect();
  }
  NimBLEDevice::deleteClient(client);
  return ok;
}

bool PrinterManager::WritePayload(::NimBLERemoteCharacteristic* writeChar,
                                  const uint8_t* payload,
                                  size_t payloadLen,
                                  uint16_t mtu) const {
  size_t chunkSize = config::kPrinterChunkSize;
  if (mtu > 3) {
    size_t mtuChunk = mtu - 3;
    if (mtuChunk < chunkSize) chunkSize = mtuChunk;
  }
  if (chunkSize == 0) chunkSize = 20;

  const uint16_t chunkDelayMs = chunkSize <= 64
      ? config::kPrinterChunkDelaySlowMs
      : config::kPrinterChunkDelayMs;

  for (size_t offset = 0; offset < payloadLen; offset += chunkSize) {
    size_t chunkLen = payloadLen - offset;
    if (chunkLen > chunkSize) chunkLen = chunkSize;

    if (!writeChar->writeValue(payload + offset, chunkLen, false)) {
      return false;
    }

    if (offset + chunkLen < payloadLen) {
      delay(chunkDelayMs);
    }
  }

  delay(config::kPrinterFinalDelayMs);
  return true;
}

}  // namespace date_label
