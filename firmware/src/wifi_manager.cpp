#include "wifi_manager.h"

#include <Arduino.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClient.h>

#include "app_config.h"
#include "config_protocol.h"

namespace date_label {

namespace {

constexpr int32_t kSecondsPerMinute = 60;
constexpr int32_t kDstOffsetSeconds = 60 * kSecondsPerMinute;

const char* WifiStatusName(wl_status_t status) {
  switch (status) {
    case WL_IDLE_STATUS: return "WL_IDLE_STATUS";
    case WL_NO_SSID_AVAIL: return "WL_NO_SSID_AVAIL";
    case WL_SCAN_COMPLETED: return "WL_SCAN_COMPLETED";
    case WL_CONNECTED: return "WL_CONNECTED";
    case WL_CONNECT_FAILED: return "WL_CONNECT_FAILED";
    case WL_CONNECTION_LOST: return "WL_CONNECTION_LOST";
    case WL_DISCONNECTED: return "WL_DISCONNECTED";
    default: return "WL_UNKNOWN";
  }
}

bool ParseDaytimeResponse(const String& line, struct tm& out, uint8_t& tt) {
  int mjd = 0;
  int year = 0;
  int month = 0;
  int day = 0;
  int hour = 0;
  int minute = 0;
  int second = 0;
  int ttValue = 0;
  int leap = 0;
  char dut1[8] = {};
  char msAdvance[8] = {};
  char label[16] = {};
  char marker = '\0';

  const int parsed = sscanf(
      line.c_str(),
      "%d %2d-%2d-%2d %2d:%2d:%2d %2d %1d %7s %7s %15s %c",
      &mjd, &year, &month, &day, &hour, &minute, &second,
      &ttValue, &leap, dut1, msAdvance, label, &marker);
  if (parsed != 13) return false;
  if (strcmp(label, "UTC(NIST)") != 0) return false;

  memset(&out, 0, sizeof(out));
  out.tm_year = (year >= 70 ? year : year + 100);
  out.tm_mon = month - 1;
  out.tm_mday = day;
  out.tm_hour = hour;
  out.tm_min = minute;
  out.tm_sec = second;
  tt = static_cast<uint8_t>(ttValue);
  return true;
}

bool IsDstActiveFromTt(uint8_t tt) {
  return tt > 0 && tt <= 50;
}

}  // namespace

void WifiManager::Begin() {
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.disconnect(false, true);
  delay(500);

  Preferences prefs;
  prefs.begin(config::kNvsNamespace, false);
  configured_ = prefs.getUChar(config::kNvsKeyConfigured, 0) != 0;
  timeZoneConfigured_ = prefs.getUChar(config::kNvsKeyTimeZoneSet, 0) != 0;
  if (timeZoneConfigured_) {
    timeZoneOffsetMinutes_ = prefs.getShort(config::kNvsKeyTimeZoneOffset, 0);
    timeZoneUsesDst_ = prefs.getUChar(config::kNvsKeyTimeZoneDst, 0) != 0;
  }

  if (configured_) {
    String ssid = prefs.getString(config::kNvsKeyWifiSsid, "");
    String pass = prefs.getString(config::kNvsKeyWifiPass, "");
    prefs.end();
    if (ssid.length() > 0) {
      strncpy(ssid_, ssid.c_str(), sizeof(ssid_) - 1);
      strncpy(pass_, pass.c_str(), sizeof(pass_) - 1);
      Serial.printf("WiFi: saved creds for \"%s\", connecting...\n", ssid_);
      AutoConnect();
      return;
    }
  } else {
    prefs.end();
  }

  Serial.println("WiFi: no saved credentials");
  status_ = WifiStatus::kIdle;
}

void WifiManager::AutoConnect() {
  WiFi.begin(ssid_, pass_);
  status_ = WifiStatus::kConnecting;
  connectPending_ = true;
  connectStartMs_ = millis();
}

void WifiManager::RetryConnect(NotifyFn notify, int status, const char* reason) {
  Serial.printf(
      "WiFi: retrying \"%s\" after %s (status=%s/%d)\n",
      ssid_, reason,
      WifiStatusName(static_cast<wl_status_t>(status)), status);
  status_ = WifiStatus::kConnecting;
  connectPending_ = true;
  connectStartMs_ = millis();
  WiFi.reconnect();
  SendStatus(notify);
}

void WifiManager::Poll(NotifyFn notify) {
  if (scanning_) {
    int16_t result = WiFi.scanComplete();
    if (result != WIFI_SCAN_RUNNING) {
      scanning_ = false;
      uint8_t buf[kMaxMsgSize];

      if (result < 0) {
        size_t len = EncodeScanDone(0, buf, sizeof(buf));
        if (len > 0) notify(buf, len);
      } else {
        uint8_t count = result > 255 ? 255 : static_cast<uint8_t>(result);
        for (uint8_t i = 0; i < count; i++) {
          int8_t rssi = static_cast<int8_t>(WiFi.RSSI(i));
          const char* ssid = WiFi.SSID(i).c_str();
          size_t len = EncodeScanResult(rssi, ssid, buf, sizeof(buf));
          if (len > 0) notify(buf, len);
          delay(20);
        }

        size_t len = EncodeScanDone(count, buf, sizeof(buf));
        if (len > 0) notify(buf, len);
        WiFi.scanDelete();
      }
    }
  }

  if (connectPending_) {
    wl_status_t ws = WiFi.status();
    if (ws == WL_CONNECTED) {
      connectPending_ = false;
      status_ = WifiStatus::kConnected;
      Serial.printf("WiFi: connected to \"%s\" IP=%s\n",
                    ssid_, WiFi.localIP().toString().c_str());

      CheckTimeSync();

      Preferences prefs;
      prefs.begin(config::kNvsNamespace, false);
      prefs.putString(config::kNvsKeyWifiSsid, ssid_);
      prefs.putString(config::kNvsKeyWifiPass, pass_);
      prefs.putUChar(config::kNvsKeyConfigured, 1);
      prefs.end();
      configured_ = true;

      SendStatus(notify);
    } else if (ws == WL_CONNECT_FAILED || ws == WL_NO_SSID_AVAIL) {
      RetryConnect(notify, ws, "connect failure");
    } else if (millis() - connectStartMs_ > kConnectTimeoutMs) {
      RetryConnect(notify, ws, "connect timeout");
    }
  } else if (status_ == WifiStatus::kConnected) {
    wl_status_t ws = WiFi.status();
    if (ws == WL_CONNECTION_LOST || ws == WL_DISCONNECTED) {
      RetryConnect(notify, ws, "connection lost");
    } else {
      CheckTimeSync();
    }
  }
}

void WifiManager::StartScan(NotifyFn notify) {
  if (scanning_) {
    uint8_t buf[kMaxMsgSize];
    size_t len = EncodeError(
        static_cast<uint8_t>(CmdType::kWifiScan),
        ErrorCode::kScanInProgress, buf, sizeof(buf));
    if (len > 0) notify(buf, len);
    return;
  }

  Serial.println("WiFi: starting scan...");
  scanning_ = true;
  WiFi.scanNetworks(true);
}

void WifiManager::StartConnect(const char* ssid, const char* pass,
                               NotifyFn notify) {
  if (connectPending_) {
    uint8_t buf[kMaxMsgSize];
    size_t len = EncodeError(
        static_cast<uint8_t>(CmdType::kWifiConnect),
        ErrorCode::kConnectInProgress, buf, sizeof(buf));
    if (len > 0) notify(buf, len);
    return;
  }

  if (scanning_) {
    WiFi.scanDelete();
    scanning_ = false;
    Serial.println("WiFi: scan aborted for connect");
  }

  WiFi.disconnect();
  strncpy(ssid_, ssid, sizeof(ssid_) - 1);
  ssid_[sizeof(ssid_) - 1] = '\0';
  strncpy(pass_, pass, sizeof(pass_) - 1);
  pass_[sizeof(pass_) - 1] = '\0';
  timeSynced_ = false;
  dstActive_ = false;
  lastTimeSyncMs_ = 0;
  lastTimeSyncAttemptMs_ = 0;

  Serial.printf("WiFi: connecting to \"%s\"...\n", ssid_);
  WiFi.begin(ssid_, pass_);
  status_ = WifiStatus::kConnecting;
  connectPending_ = true;
  connectStartMs_ = millis();
  SendStatus(notify);
}

void WifiManager::Clear(NotifyFn notify) {
  WiFi.disconnect();
  ssid_[0] = '\0';
  pass_[0] = '\0';
  status_ = WifiStatus::kIdle;
  connectPending_ = false;
  configured_ = false;
  timeSynced_ = false;
  timeZoneConfigured_ = false;
  timeZoneOffsetMinutes_ = 0;
  timeZoneUsesDst_ = false;
  dstActive_ = false;
  lastTimeSyncMs_ = 0;
  lastTimeSyncAttemptMs_ = 0;

  Preferences prefs;
  prefs.begin(config::kNvsNamespace, false);
  prefs.remove(config::kNvsKeyWifiSsid);
  prefs.remove(config::kNvsKeyWifiPass);
  prefs.remove(config::kNvsKeyPrinterAddr);
  prefs.remove(config::kNvsKeyTimeZoneOffset);
  prefs.remove(config::kNvsKeyTimeZoneDst);
  prefs.putUChar(config::kNvsKeyTimeZoneSet, 0);
  prefs.putUChar(config::kNvsKeyConfigured, 0);
  prefs.end();

  Serial.println("WiFi: config cleared");
  SendStatus(notify);
}

bool WifiManager::LoadSaved(char* ssid, size_t ssidCap,
                            char* pass, size_t passCap) {
  Preferences prefs;
  prefs.begin(config::kNvsNamespace, true);
  bool configured = prefs.getUChar(config::kNvsKeyConfigured, 0) != 0;
  if (!configured) {
    prefs.end();
    return false;
  }
  String s = prefs.getString(config::kNvsKeyWifiSsid, "");
  String p = prefs.getString(config::kNvsKeyWifiPass, "");
  prefs.end();

  if (s.length() == 0) return false;
  strncpy(ssid, s.c_str(), ssidCap - 1);
  ssid[ssidCap - 1] = '\0';
  strncpy(pass, p.c_str(), passCap - 1);
  pass[passCap - 1] = '\0';
  return true;
}

bool WifiManager::SaveTimeZone(int16_t offsetMinutes, bool useDst) {
  Preferences prefs;
  prefs.begin(config::kNvsNamespace, false);
  prefs.putShort(config::kNvsKeyTimeZoneOffset, offsetMinutes);
  prefs.putUChar(config::kNvsKeyTimeZoneDst, useDst ? 1 : 0);
  prefs.putUChar(config::kNvsKeyTimeZoneSet, 1);
  prefs.end();

  timeZoneConfigured_ = true;
  timeZoneOffsetMinutes_ = offsetMinutes;
  timeZoneUsesDst_ = useDst;
  return true;
}

bool WifiManager::LoadTimeZone(int16_t& offsetMinutes, bool& useDst) const {
  if (!timeZoneConfigured_) return false;
  offsetMinutes = timeZoneOffsetMinutes_;
  useDst = timeZoneUsesDst_;
  return true;
}

void WifiManager::SendStatus(NotifyFn notify) {
  uint8_t buf[kMaxMsgSize];
  const char* name = (status_ == WifiStatus::kConnected ||
                      status_ == WifiStatus::kConnecting)
                         ? ssid_
                         : nullptr;
  size_t len = EncodeWifiStatus(status_, name, buf, sizeof(buf));
  if (len > 0) notify(buf, len);
}

void WifiManager::CheckTimeSync() {
  const unsigned long nowMs = millis();
  const bool syncStale =
      !timeSynced_ || (nowMs - lastTimeSyncMs_ >= kTimeSyncRefreshMs);
  if (!syncStale) return;

  if (lastTimeSyncAttemptMs_ != 0 &&
      nowMs - lastTimeSyncAttemptMs_ < kTimeSyncRetryMs) {
    return;
  }
  lastTimeSyncAttemptMs_ = nowMs;

  WiFiClient client;
  client.setTimeout(5000);
  if (!client.connect(config::kTimeSyncHost, config::kTimeSyncPort)) {
    Serial.println("WiFi: time sync TCP connect failed");
    return;
  }

  String line;
  for (uint8_t attempt = 0; attempt < 4; ++attempt) {
    line = client.readStringUntil('\n');
    line.trim();
    if (line.length() > 0) break;
  }
  client.stop();
  if (line.length() == 0) {
    Serial.println("WiFi: empty Daytime response");
    return;
  }

  struct tm timeinfo;
  uint8_t tt = 0;
  if (!ParseDaytimeResponse(line, timeinfo, tt)) {
    Serial.printf("WiFi: invalid Daytime response: %s\n", line.c_str());
    return;
  }

  time_t t = mktime(&timeinfo);
  if (t < 0) {
    Serial.println("WiFi: failed to convert Daytime response");
    return;
  }

  struct timeval tv = {.tv_sec = t, .tv_usec = 0};
  settimeofday(&tv, nullptr);

  dstActive_ = IsDstActiveFromTt(tt);
  timeSynced_ = true;
  lastTimeSyncMs_ = nowMs;
  Serial.printf("WiFi: time synced via Daytime (TT=%u DST=%u): %s\n",
                tt, dstActive_ ? 1 : 0, line.c_str());
}

int32_t WifiManager::CurrentUtcOffsetSeconds() const {
  if (!timeZoneConfigured_) return 0;

  int32_t offsetSeconds =
      static_cast<int32_t>(timeZoneOffsetMinutes_) * kSecondsPerMinute;
  if (timeZoneUsesDst_ && dstActive_) {
    offsetSeconds += kDstOffsetSeconds;
  }
  return offsetSeconds;
}

bool WifiManager::GetDateString(char* buf, size_t cap) const {
  if (!timeSynced_ || !timeZoneConfigured_ || cap < 11) return false;
  time_t now = time(nullptr) + CurrentUtcOffsetSeconds();
  struct tm timeinfo;
  gmtime_r(&now, &timeinfo);
  strftime(buf, cap, "%Y/%m/%d", &timeinfo);
  return true;
}

bool WifiManager::GetTimeDisplayString(char* buf, size_t cap) const {
  if (!timeSynced_ || !timeZoneConfigured_ || cap < 17) return false;
  time_t now = time(nullptr) + CurrentUtcOffsetSeconds();
  struct tm timeinfo;
  gmtime_r(&now, &timeinfo);
  strftime(buf, cap, "%Y/%m/%d %H:%M", &timeinfo);
  return true;
}

}  // namespace date_label
