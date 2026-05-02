#include "wifi_manager.h"

#include <Arduino.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "app_config.h"
#include "config_protocol.h"

namespace date_label {

namespace {

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

bool IsDateStringValid(const String& dateStr) {
  return dateStr.length() == 25 &&
         isDigit(dateStr[0]) &&
         isDigit(dateStr[1]) &&
         isDigit(dateStr[2]) &&
         isDigit(dateStr[3]) &&
         dateStr[4] == '-' &&
         isDigit(dateStr[5]) &&
         isDigit(dateStr[6]) &&
         dateStr[7] == '-' &&
         isDigit(dateStr[8]) &&
         isDigit(dateStr[9]) &&
         dateStr[10] == 'T' &&
         isDigit(dateStr[11]) &&
         isDigit(dateStr[12]) &&
         dateStr[13] == ':' &&
         isDigit(dateStr[14]) &&
         isDigit(dateStr[15]) &&
         dateStr[16] == ':' &&
         isDigit(dateStr[17]) &&
         isDigit(dateStr[18]) &&
         (dateStr[19] == '+' || dateStr[19] == '-') &&
         isDigit(dateStr[20]) &&
         isDigit(dateStr[21]) &&
         dateStr[22] == ':' &&
         isDigit(dateStr[23]) &&
         isDigit(dateStr[24]);
}

bool ParseDateTimeResponse(const String& dateStr, struct tm& out, int32_t& utcOffsetSeconds) {
  if (!IsDateStringValid(dateStr)) return false;

  memset(&out, 0, sizeof(out));
  out.tm_year = dateStr.substring(0, 4).toInt() - 1900;
  out.tm_mon = dateStr.substring(5, 7).toInt() - 1;
  out.tm_mday = dateStr.substring(8, 10).toInt();
  out.tm_hour = dateStr.substring(11, 13).toInt();
  out.tm_min = dateStr.substring(14, 16).toInt();
  out.tm_sec = dateStr.substring(17, 19).toInt();

  const int offsetHours = dateStr.substring(20, 22).toInt();
  const int offsetMinutes = dateStr.substring(23, 25).toInt();
  utcOffsetSeconds = (offsetHours * 60 + offsetMinutes) * 60;
  if (dateStr[19] == '-') utcOffsetSeconds = -utcOffsetSeconds;

  return true;
}

}  // namespace

void WifiManager::Begin() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.disconnect();

  Preferences prefs;
  prefs.begin(config::kNvsNamespace, false);
  bool configured = prefs.getUChar(config::kNvsKeyConfigured, 0) != 0;
  if (configured) {
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
  WiFi.disconnect();
  delay(100);
  AutoConnect();
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
          delay(20);  // let BLE stack flush each notification
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

      // Sync local clock from the date service.
      CheckTimeSync();

      // Save to NVS.
      Preferences prefs;
      prefs.begin(config::kNvsNamespace, false);
      prefs.putString(config::kNvsKeyWifiSsid, ssid_);
      prefs.putString(config::kNvsKeyWifiPass, pass_);
      prefs.putUChar(config::kNvsKeyConfigured, 1);
      prefs.end();

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
  WiFi.scanNetworks(true);  // async=true
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
  utcOffsetSeconds_ = 0;
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
  timeSynced_ = false;
  utcOffsetSeconds_ = 0;
  lastTimeSyncMs_ = 0;
  lastTimeSyncAttemptMs_ = 0;

  Preferences prefs;
  prefs.begin(config::kNvsNamespace, false);
  prefs.remove(config::kNvsKeyWifiSsid);
  prefs.remove(config::kNvsKeyWifiPass);
  prefs.putUChar(config::kNvsKeyConfigured, 0);
  prefs.end();

  Serial.println("WiFi: credentials cleared");
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

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.setConnectTimeout(5000);
  http.setTimeout(5000);

  if (!http.begin(client, config::kTimeSyncUrl)) {
    Serial.println("WiFi: time sync HTTPS setup failed");
    return;
  }

  int status = http.GET();
  if (status != HTTP_CODE_OK) {
    Serial.printf("WiFi: time sync HTTPS GET failed (%d)\n", status);
    http.end();
    return;
  }

  String body = http.getString();
  http.end();
  body.trim();

  struct tm timeinfo;
  int32_t utcOffsetSeconds = 0;
  if (!ParseDateTimeResponse(body, timeinfo, utcOffsetSeconds)) {
    Serial.printf("WiFi: invalid datetime response: %s\n", body.c_str());
    return;
  }

  time_t t = mktime(&timeinfo);
  if (t < 0) {
    Serial.println("WiFi: failed to convert datetime response");
    return;
  }

  t -= utcOffsetSeconds;
  struct timeval tv = {.tv_sec = t, .tv_usec = 0};
  settimeofday(&tv, nullptr);

  utcOffsetSeconds_ = utcOffsetSeconds;
  timeSynced_ = true;
  lastTimeSyncMs_ = nowMs;
  Serial.printf("WiFi: time synced via HTTPS: %s\n", body.c_str());
}

bool WifiManager::GetDateString(char* buf, size_t cap) const {
  if (!timeSynced_ || cap < 11) return false;
  time_t now = time(nullptr) + utcOffsetSeconds_;
  struct tm timeinfo;
  gmtime_r(&now, &timeinfo);
  strftime(buf, cap, "%Y/%m/%d", &timeinfo);
  return true;
}

}  // namespace date_label
