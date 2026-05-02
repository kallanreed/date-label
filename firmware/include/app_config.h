#pragma once

#include <stdint.h>

namespace date_label::config {

// ── Hardware ─────────────────────────────────────────────────────────────
constexpr int8_t kButtonPin = 9;  // GPIO9 (boot button on most C3 boards)
constexpr int8_t kLedPin = -1;    // -1 = no LED

// ── D12 Printer BLE ──────────────────────────────────────────────────────
constexpr char kPrinterServiceUuid[] = "0000ff00-0000-1000-8000-00805f9b34fb";
constexpr char kPrinterWriteUuid[]   = "0000ff02-0000-1000-8000-00805f9b34fb";
constexpr char kPrinterNotifyUuid[]  = "0000ff03-0000-1000-8000-00805f9b34fb";
constexpr uint16_t kPrinterChunkSize = 1024;
constexpr uint16_t kPrinterChunkDelayMs = 5;
constexpr uint8_t kPrinterDensity = 3;
constexpr uint8_t kPrinterPaperTypeGap = 0;

// ── Config BLE Service (Peripheral) ─────────────────────────────────────
constexpr char kBleDeviceName[] = "DatePrinter";
constexpr char kConfigServiceUuid[] = "12345678-1234-1234-1234-123456789abc";
constexpr char kConfigWriteUuid[]   = "12345678-1234-1234-1234-00000000ff01";
constexpr char kConfigNotifyUuid[]  = "12345678-1234-1234-1234-00000000ff02";

// ── Label Dimensions ─────────────────────────────────────────────────────
constexpr uint16_t kMaxPrintWidthPx = 96;   // 12mm at 203 DPI
constexpr uint16_t kLabelWidthMm = 15;
constexpr uint16_t kLabelHeightMm = 40;

// ── Date Rendering ───────────────────────────────────────────────────────
constexpr uint8_t kFontCharWidth = 8;
constexpr uint8_t kFontCharHeight = 14;
constexpr uint8_t kFontCharGap = 1;
// "yyyy/MM/dd" = 10 chars, 2 slashes
constexpr uint8_t kDateStringLength = 10;

// ── Time Sync ────────────────────────────────────────────────────────────
constexpr char kTimeSyncUrl[] = "http://www.google.com";

// ── NVS Keys ─────────────────────────────────────────────────────────────
constexpr char kNvsNamespace[] = "datelabel";
constexpr char kNvsKeyWifiSsid[] = "wifi_ssid";
constexpr char kNvsKeyWifiPass[] = "wifi_pass";
constexpr char kNvsKeyPrinterAddr[] = "printer_addr";
constexpr char kNvsKeyConfigured[] = "configured";

}  // namespace date_label::config
