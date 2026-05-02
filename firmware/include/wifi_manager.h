#pragma once

#include <stddef.h>
#include <stdint.h>

#include "config_protocol.h"

namespace date_label {

using NotifyFn = void (*)(const uint8_t* data, size_t len);

class WifiManager {
 public:
  void Begin();
  void Poll(NotifyFn notify);

  void StartScan(NotifyFn notify);
  void StartConnect(const char* ssid, const char* pass, NotifyFn notify);
  void Clear(NotifyFn notify);

  WifiStatus status() const { return status_; }
  const char* ssid() const { return ssid_; }

  bool LoadSaved(char* ssid, size_t ssidCap, char* pass, size_t passCap);

  bool scanning() const { return scanning_; }
  bool connecting() const { return connectPending_; }
  bool timeSynced() const { return timeSynced_; }

  // Write "yyyy/MM/dd" into buf (must be >= 11 bytes). Returns true if time is valid.
  bool GetDateString(char* buf, size_t cap) const;

 private:
  void AutoConnect();
  void SendStatus(NotifyFn notify);
  void CheckTimeSync();
  void RetryConnect(NotifyFn notify, int status, const char* reason);

  WifiStatus status_ = WifiStatus::kIdle;
  char ssid_[33] = {};
  char pass_[65] = {};
  bool scanning_ = false;
  bool connectPending_ = false;
  bool timeSynced_ = false;
  int32_t utcOffsetSeconds_ = 0;
  unsigned long lastTimeSyncMs_ = 0;
  unsigned long lastTimeSyncAttemptMs_ = 0;
  unsigned long connectStartMs_ = 0;
  static constexpr unsigned long kConnectTimeoutMs = 30000;
  static constexpr unsigned long kTimeSyncRefreshMs = 12UL * 60UL * 60UL * 1000UL;
  static constexpr unsigned long kTimeSyncRetryMs = 60UL * 1000UL;
};

}  // namespace date_label
