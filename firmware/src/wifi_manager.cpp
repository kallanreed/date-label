#include "wifi_manager.h"

#include <Arduino.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClient.h>

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

      // Fetch time via HTTP.
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

// Parse HTTP Date header: "Sat, 02 May 2026 15:30:00 GMT"
static bool ParseHttpDate(const char* dateStr, struct tm& out) {
  static const char* months[] = {
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
  };

  // Skip day name — find first space after comma.
  const char* p = strchr(dateStr, ',');
  if (!p) return false;
  p++;  // skip comma
  while (*p == ' ') p++;

  int day, year, hour, min, sec;
  char monStr[4] = {};
  if (sscanf(p, "%d %3s %d %d:%d:%d",
             &day, monStr, &year, &hour, &min, &sec) != 6) {
    return false;
  }

  int mon = -1;
  for (int i = 0; i < 12; i++) {
    if (strcmp(monStr, months[i]) == 0) { mon = i; break; }
  }
  if (mon < 0) return false;

  memset(&out, 0, sizeof(out));
  out.tm_year = year - 1900;
  out.tm_mon = mon;
  out.tm_mday = day;
  out.tm_hour = hour;
  out.tm_min = min;
  out.tm_sec = sec;
  return true;
}

void WifiManager::CheckTimeSync() {
  if (timeSynced_) return;

  // Raw TCP connection — avoids pulling in HTTPClient/TLS.
  WiFiClient client;
  if (!client.connect("www.google.com", 80, 5000)) {
    Serial.println("WiFi: time sync connect failed");
    return;
  }

  client.print("HEAD / HTTP/1.1\r\nHost: www.google.com\r\nConnection: close\r\n\r\n");

  // Read response headers looking for Date.
  unsigned long start = millis();
  while (client.connected() && millis() - start < 5000) {
    String line = client.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) break;  // end of headers

    if (line.startsWith("Date: ")) {
      struct tm timeinfo;
      if (ParseHttpDate(line.c_str() + 6, timeinfo)) {
        time_t t = mktime(&timeinfo);
        struct timeval tv = {.tv_sec = t, .tv_usec = 0};
        settimeofday(&tv, nullptr);

        timeSynced_ = true;
        char buf[11];
        strftime(buf, sizeof(buf), "%Y/%m/%d", &timeinfo);
        Serial.printf("WiFi: time synced via HTTP: %s\n", buf);
      } else {
        Serial.printf("WiFi: failed to parse Date: %s\n", line.c_str() + 6);
      }
      break;
    }
  }
  client.stop();
}

bool WifiManager::GetDateString(char* buf, size_t cap) const {
  if (!timeSynced_ || cap < 11) return false;
  time_t now = time(nullptr);
  struct tm timeinfo;
  gmtime_r(&now, &timeinfo);
  strftime(buf, cap, "%Y/%m/%d", &timeinfo);
  return true;
}

}  // namespace date_label
