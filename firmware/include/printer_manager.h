#pragma once

#include <stddef.h>
#include <stdint.h>

class NimBLERemoteCharacteristic;

namespace date_label {

class WifiManager;

class PrinterManager {
 public:
  enum class PrintResult {
    kOk,
    kPrinterNotConfigured,
    kTimeNotSynced,
    kRenderFailed,
    kConnectionFailed,
    kServiceMissing,
    kWriteFailed,
  };

  bool SaveAddress(const char* address);
  bool LoadAddress(char* address, size_t cap) const;
  PrintResult PrintCurrentDate(const WifiManager& wifi);

 private:
  bool TryPrintWithAddressType(const char* address, uint8_t addrType,
                               const uint8_t* payload, size_t payloadLen) const;
  bool WritePayload(::NimBLERemoteCharacteristic* writeChar,
                    const uint8_t* payload, size_t payloadLen,
                    uint16_t mtu) const;
};

}  // namespace date_label
