#include "device_ui.h"

#include <Arduino.h>

#include "app_config.h"
#include "ble_config_service.h"
#include "wifi_manager.h"

namespace date_label {

namespace {

constexpr uint8_t kPwmResolutionBits = 8;
constexpr uint32_t kPwmFrequencyHz = 5000;
constexpr uint8_t kPwmMaxDuty = (1u << kPwmResolutionBits) - 1u;
constexpr uint8_t kLedChannelRed = 0;
constexpr uint8_t kLedChannelGreen = 1;
constexpr uint8_t kLedChannelBlue = 2;
constexpr unsigned long kButtonDebounceMs = 35;
constexpr unsigned long kPrinterRefreshMs = 1000;

bool IsPressedLevel(int level) {
  return level == LOW;
}

}  // namespace

void DeviceUi::Begin() {
  pinMode(config::kButtonPin, INPUT_PULLUP);

  ledcSetup(kLedChannelRed, kPwmFrequencyHz, kPwmResolutionBits);
  ledcSetup(kLedChannelGreen, kPwmFrequencyHz, kPwmResolutionBits);
  ledcSetup(kLedChannelBlue, kPwmFrequencyHz, kPwmResolutionBits);
  ledcAttachPin(config::kStatusLedRedPin, kLedChannelRed);
  ledcAttachPin(config::kStatusLedGreenPin, kLedChannelGreen);
  ledcAttachPin(config::kStatusLedBluePin, kLedChannelBlue);

  buttonStablePressed_ = IsPressedLevel(digitalRead(config::kButtonPin));
  buttonLastReadingPressed_ = buttonStablePressed_;
  buttonLastChangeMs_ = millis();
  ApplyColor(ColorForState(currentState_));
}

void DeviceUi::Poll(const WifiManager& wifi, BleConfigService& bleConfig) {
  PollButton(bleConfig);
  UpdateStatusLed(wifi, bleConfig);
}

void DeviceUi::PollButton(BleConfigService& bleConfig) {
  const bool pressed = IsPressedLevel(digitalRead(config::kButtonPin));
  const unsigned long nowMs = millis();

  if (pressed != buttonLastReadingPressed_) {
    buttonLastReadingPressed_ = pressed;
    buttonLastChangeMs_ = nowMs;
  }

  if (nowMs - buttonLastChangeMs_ < kButtonDebounceMs ||
      pressed == buttonStablePressed_) {
    return;
  }

  buttonStablePressed_ = pressed;
  if (buttonStablePressed_) {
    bleConfig.RequestPrint();
  }
}

void DeviceUi::UpdateStatusLed(const WifiManager& wifi,
                               const BleConfigService& bleConfig) {
  StatusState nextState = StatusState::kReady;
  if (bleConfig.IsPrinting()) {
    nextState = StatusState::kPrinting;
  } else if (!wifi.configured()) {
    nextState = StatusState::kUnconfigured;
  } else if (wifi.status() != WifiStatus::kConnected) {
    nextState = StatusState::kNoWifi;
  } else if (!wifi.timeSynced()) {
    nextState = StatusState::kNoTime;
  } else {
    const unsigned long nowMs = millis();
    if (lastPrinterRefreshMs_ == 0 ||
        nowMs - lastPrinterRefreshMs_ >= kPrinterRefreshMs) {
      printerConfigured_ = bleConfig.HasSavedPrinter();
      lastPrinterRefreshMs_ = nowMs;
    }
  }

  if (nextState == StatusState::kReady && !printerConfigured_) {
    nextState = StatusState::kNoPrinter;
  }

  if (nextState == currentState_) return;
  currentState_ = nextState;
  ApplyColor(ColorForState(currentState_));
}

void DeviceUi::ApplyColor(RgbColor color) {
  uint8_t red = ScaleChannel(color.red);
  uint8_t green = ScaleChannel(color.green);
  uint8_t blue = ScaleChannel(color.blue);

  if (config::kStatusLedActiveLow) {
    red = kPwmMaxDuty - red;
    green = kPwmMaxDuty - green;
    blue = kPwmMaxDuty - blue;
  }

  ledcWrite(kLedChannelRed, red);
  ledcWrite(kLedChannelGreen, green);
  ledcWrite(kLedChannelBlue, blue);
}

DeviceUi::RgbColor DeviceUi::ColorForState(StatusState state) {
  constexpr RgbColor kColorOff = {0, 0, 0};
  constexpr RgbColor kColorRed = {255, 0, 0};
  constexpr RgbColor kColorOrange = {255, 96, 0};
  constexpr RgbColor kColorYellow = {255, 200, 0};
  constexpr RgbColor kColorBlue = {0, 0, 255};
  constexpr RgbColor kColorWhite = {255, 255, 255};
  constexpr RgbColor kColorGreen = {0, 255, 0};

  switch (state) {
    case StatusState::kUnconfigured: return kColorRed;
    case StatusState::kNoWifi: return kColorOrange;
    case StatusState::kNoTime: return kColorYellow;
    case StatusState::kNoPrinter: return kColorBlue;
    case StatusState::kPrinting: return kColorWhite;
    case StatusState::kReady: return kColorGreen;
  }

  return kColorOff;
}

uint8_t DeviceUi::ScaleChannel(uint8_t value) {
  return static_cast<uint8_t>(
      (static_cast<uint16_t>(value) * config::kStatusLedMaxBrightness) / 255u);
}

}  // namespace date_label
