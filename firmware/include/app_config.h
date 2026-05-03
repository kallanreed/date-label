#pragma once

#include <stdint.h>

namespace date_label::config {

// ── Hardware ─────────────────────────────────────────────────────────────
constexpr int8_t kButtonPin = 6;  // D4 on XIAO ESP32C3
constexpr int8_t kStatusLedRedPin = 3;    // D1
constexpr int8_t kStatusLedGreenPin = 4;  // D2
constexpr int8_t kStatusLedBluePin = 5;   // D3
constexpr bool kStatusLedActiveLow = false;  // Common-cathode RGB LED tied to GND.
constexpr uint8_t kStatusLedMaxBrightness = 48;

// ── D12 Printer BLE ──────────────────────────────────────────────────────
constexpr char kPrinterServiceUuid[] = "0000ff00-0000-1000-8000-00805f9b34fb";
constexpr char kPrinterWriteUuid[]   = "0000ff02-0000-1000-8000-00805f9b34fb";
constexpr uint16_t kPrinterChunkSize = 64;
constexpr uint16_t kPrinterChunkDelayMs = 12;
constexpr uint16_t kPrinterChunkDelaySlowMs = 20;
constexpr uint16_t kPrinterFinalDelayMs = 750;
constexpr uint8_t kPrinterDensity = 3;
constexpr uint8_t kPrinterPaperTypeGap = 0;

// ── Config BLE Service (Peripheral) ─────────────────────────────────────
constexpr char kBleDeviceName[] = "DatePrinter";
constexpr char kConfigServiceUuid[] = "12345678-1234-1234-1234-123456789abc";
constexpr char kConfigWriteUuid[]   = "12345678-1234-1234-1234-00000000ff01";
constexpr char kConfigNotifyUuid[]  = "12345678-1234-1234-1234-00000000ff02";

constexpr uint16_t kMaxPrintWidthPx = 96;   // 12mm at 203 DPI

// ── Time Sync ────────────────────────────────────────────────────────────
constexpr char kTimeSyncHost[] = "time.nist.gov";
constexpr uint16_t kTimeSyncPort = 13;

// ── NVS Keys ─────────────────────────────────────────────────────────────
constexpr char kNvsNamespace[] = "datelabel";
constexpr char kNvsKeyWifiSsid[] = "wifi_ssid";
constexpr char kNvsKeyWifiPass[] = "wifi_pass";
constexpr char kNvsKeyPrinterAddr[] = "printer_addr";
constexpr char kNvsKeyConfigured[] = "configured";
constexpr char kNvsKeyTimeZoneOffset[] = "tz_offset";
constexpr char kNvsKeyTimeZoneDst[] = "tz_dst";
constexpr char kNvsKeyTimeZoneSet[] = "tz_set";

}  // namespace date_label::config
