#pragma once

#include <stdint.h>

namespace date_label {

class BleConfigService;
class WifiManager;

class DeviceUi {
 public:
  void Begin();
  void Poll(const WifiManager& wifi, BleConfigService& bleConfig);

 private:
  enum class StatusState : uint8_t {
    kUnconfigured,
    kNoWifi,
    kNoTime,
    kNoPrinter,
    kPrinting,
    kReady,
  };

  struct RgbColor {
    uint8_t red;
    uint8_t green;
    uint8_t blue;
  };

  void PollButton(BleConfigService& bleConfig);
  void UpdateStatusLed(const WifiManager& wifi, const BleConfigService& bleConfig);
  void ApplyColor(RgbColor color);
  static RgbColor ColorForState(StatusState state);
  static uint8_t ScaleChannel(uint8_t value);

  StatusState currentState_ = StatusState::kUnconfigured;
  bool buttonStablePressed_ = false;
  bool buttonLastReadingPressed_ = false;
  unsigned long buttonLastChangeMs_ = 0;
  bool printerConfigured_ = false;
  unsigned long lastPrinterRefreshMs_ = 0;
};

}  // namespace date_label
