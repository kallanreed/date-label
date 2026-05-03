# ESP32 Date Printer — Current Firmware Spec

This document describes the firmware and web UI that are implemented in this repository today.

The device is a **Seeed XIAO ESP32C3** that:

- stores WiFi credentials, printer binding, and timezone settings in NVS
- exposes a custom BLE config service for phone-based setup
- syncs UTC from **`time.nist.gov:13`** using the **Daytime protocol**
- converts that UTC time to a local date using a saved UTC offset and optional DST handling
- renders `yyyy/MM/dd` as a 1-bit bitmap
- prints that bitmap to a **Labelnize / Nelko D12** over BLE
- supports both a **web UI print button** and a **physical button** on the device
- drives a compact **RGB status LED**

## Hardware

### Target board

- **Seeed XIAO ESP32C3**

### Current pin mapping

| Function | XIAO Pin | GPIO |
|---|---:|---:|
| Status LED red | D1 | GPIO3 |
| Status LED green | D2 | GPIO4 |
| Status LED blue | D3 | GPIO5 |
| Print button | D4 | GPIO6 |

### Electrical assumptions

- RGB LED is currently configured as **common-cathode**
- Button is wired from **D4 to GND**
- Button input uses **`INPUT_PULLUP`**
- LED brightness is intentionally capped below full duty cycle to reduce power draw

## High-level flow

```text
Boot
  ├─ Initialize NVS
  ├─ Load saved WiFi config
  ├─ Load saved timezone config
  ├─ Load saved printer binding state
  ├─ Start BLE config service
  ├─ Start hardware UI (button + RGB LED)
  └─ Main loop
       ├─ Poll WiFi manager
       ├─ Keep time synced from NIST Daytime when WiFi is connected
       ├─ Handle BLE config commands
       ├─ Handle preview bitmap transfer
       ├─ Handle print requests
       └─ Update button/LED state
```

## BLE configuration service

The ESP32 advertises as **`DatePrinter`** with:

- **Service UUID:** `12345678-1234-1234-1234-123456789abc`
- **Write characteristic:** `12345678-1234-1234-1234-00000000ff01`
- **Notify/indicate characteristic:** `12345678-1234-1234-1234-00000000ff02`

Messages use a simple frame:

- byte 0: message type
- byte 1: payload length
- bytes 2..N: payload

### Implemented commands

| Command | Value | Purpose |
|---|---:|---|
| `kWifiScan` | `0x01` | Scan for nearby WiFi networks |
| `kWifiConnect` | `0x02` | Save WiFi credentials and connect |
| `kWifiGetStatus` | `0x03` | Get current WiFi status |
| `kWifiGetSaved` | `0x04` | Get saved WiFi SSID/password |
| `kWifiClear` | `0x05` | Clear all saved config |
| `kGetTimeStatus` | `0x06` | Get current local device time |
| `kGetDateBitmap` | `0x07` | Stream rendered date bitmap |
| `kPrinterScan` | `0x08` | Scan for D12 printers |
| `kPrinterBind` | `0x09` | Save printer BLE address |
| `kPrinterGetSaved` | `0x0A` | Get saved printer address |
| `kPrintLabel` | `0x0B` | Print the current label |
| `kTimeZoneSet` | `0x0C` | Save timezone offset + DST mode |
| `kTimeZoneGetSaved` | `0x0D` | Get saved timezone config |

### Implemented responses

| Response | Value | Purpose |
|---|---:|---|
| `kWifiScanResult` | `0x81` | One WiFi scan result |
| `kWifiScanDone` | `0x82` | WiFi scan complete |
| `kWifiStatus` | `0x83` | WiFi status update |
| `kWifiSaved` | `0x84` | Saved WiFi config |
| `kAck` | `0x85` | Command completed |
| `kError` | `0x86` | Command failed |
| `kTimeStatus` | `0x87` | Current local time string |
| `kDateBitmapHeader` | `0x88` | Bitmap size header |
| `kDateBitmapData` | `0x89` | Bitmap chunk |
| `kPrinterScanResult` | `0x8A` | One printer scan result |
| `kPrinterScanDone` | `0x8B` | Printer scan complete |
| `kPrinterSaved` | `0x8C` | Saved printer address |
| `kTimeZoneSaved` | `0x8D` | Saved timezone config |

## Web UI

The web app is a compact mobile-oriented SPA using Web Bluetooth.

### Current sections

1. **Device**
   - Connect / disconnect from the ESP32

2. **Status**
   - WiFi summary
   - Current local device time

3. **Config**
   - WiFi SSID row with inline editor
   - Printer row with inline editor
   - Time Zone row with inline editor
   - Clear Config button

4. **Label Preview**
   - Refresh Preview
   - Print Label

### Current timezone UX

Timezone is saved as:

- a fixed **UTC offset** in minutes
- plus a boolean **"Use NIST DST flag"**

Example input:

- `-07:00`
- `+01:00`
- `+05:30`

When DST mode is enabled, the firmware uses the Daytime **TT** field:

- `TT > 0 && TT <= 50` => DST active
- other values => standard time

## Time sync

### Current implementation

Time sync no longer uses HTTPS or the old cloud date endpoint.

The firmware now:

1. connects to **`time.nist.gov`**
2. opens TCP **port 13**
3. reads the NIST **Daytime** ASCII line
4. parses the UTC timestamp and TT field
5. stores UTC in the device clock with `settimeofday()`
6. derives local time from:
   - saved UTC offset
   - optional DST adjustment using TT

### Notes

- The NIST server may send a leading blank line before the actual record; firmware skips blank lines.
- If timezone has not been configured, local date/time are treated as unavailable even if UTC sync succeeded.

## WiFi behavior

### Current behavior

- saved WiFi credentials are loaded from NVS at boot
- the device auto-connects when credentials exist
- on connection failure or disconnect, the firmware retries
- WiFi scan results are streamed over BLE as individual result messages
- successful WiFi connection saves the credentials in NVS

### NVS keys

| Key | Type | Meaning |
|---|---|---|
| `wifi_ssid` | string | Saved WiFi SSID |
| `wifi_pass` | string | Saved WiFi password |
| `printer_addr` | string | Saved D12 BLE address |
| `configured` | u8 | WiFi credentials configured |
| `tz_offset` | i16 | Saved UTC offset in minutes |
| `tz_dst` | u8 | Whether DST-from-TT is enabled |
| `tz_set` | u8 | Timezone configured flag |

### Clear Config behavior

The current `Clear Config` action clears **all** saved config:

- WiFi SSID
- WiFi password
- printer address
- timezone offset
- timezone DST flag
- configured flags

## Printer setup and printing

### Printer discovery

The ESP32 scans for BLE devices that either:

- advertise service `0000ff00-0000-1000-8000-00805f9b34fb`
- or contain `D12` in the device name

Selected printer address is stored in NVS.

### D12 BLE parameters

| Parameter | Value |
|---|---|
| Service | `0000ff00-0000-1000-8000-00805f9b34fb` |
| Write characteristic | `0000ff02-0000-1000-8000-00805f9b34fb` |
| Write type | Write Without Response |

### Current print transport tuning

These values are tuned for the XIAO ESP32C3:

| Setting | Value |
|---|---:|
| Chunk size | 64 bytes |
| Chunk delay | 12 ms |
| Slow chunk delay | 20 ms |
| Final delay before disconnect | 750 ms |

The firmware connects to the printer on demand for each print job, sends the full payload, waits, then disconnects.

### Print payload

The firmware uses the D12 **AY / ESC** binary protocol documented in `docs/PROTOCOL.md`.

Current sequence:

1. Enable
2. Wakeup (12 zero bytes)
3. Centered location
4. Density = 3
5. Gap-label paper type
6. Uncompressed `GS v 0` bitmap image
7. Line advance
8. Gap detect
9. Stop/print command

## Date rendering

### Current output

- date format: **`yyyy/MM/dd`**
- rendered as a **1-bit monochrome bitmap**
- rotated **90° clockwise**
- centered within the printer width constraint

### Width limit

- max print width: **96 px**

## Physical controls

### Button

- physical button press queues the same print flow used by the web UI
- debounced in firmware
- uses the saved WiFi, timezone, and printer configuration

### RGB status LED

Current states:

| State | Color |
|---|---|
| Unconfigured | Red |
| No WiFi | Orange |
| No time | Yellow |
| No printer | Blue |
| Printing | White |
| Ready | Green |

## State model

The current device behavior is best described as:

```text
BOOT
  ├─ BLE config service starts
  ├─ hardware UI starts
  └─ if WiFi creds exist:
       └─ connect WiFi
            └─ sync UTC from NIST Daytime

READY CONDITIONS
  - WiFi configured
  - WiFi connected
  - timezone configured
  - time synced
  - printer configured

PRINT FLOW
  - request from web UI or physical button
  - render date bitmap
  - connect to D12
  - stream print payload
  - disconnect
  - return to ready
```

## Dependencies

### Firmware

- `NimBLE-Arduino`
- `WiFi.h`
- `WiFiClient`
- `Preferences.h`

### Frontend

- vanilla HTML/CSS/JS
- Web Bluetooth API

## Notes

- Web Bluetooth still requires HTTPS hosting for the setup app.
- Safari/iOS still does not support Web Bluetooth.
- The old cloud-based date helper is no longer part of the active time-sync path.
- The D12 auto-sleeps quickly, so the firmware is intentionally connect/print/disconnect rather than maintaining a persistent BLE connection.
