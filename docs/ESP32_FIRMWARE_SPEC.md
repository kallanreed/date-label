# ESP32 Date Printer — Firmware Spec

An ESP32 that prints the current date on a D12 thermal label printer
when you press a button. Dot-matrix style font, format `yyyy/MM/dd`.

## Hardware

- ESP32-C3 (or any ESP32 with BLE 5.0)
- Momentary push button on a GPIO (e.g. GPIO9 on C3 dev boards — often has a boot button)
- Optional: LED for status indication

## High-Level Flow

```
Power on
  ├─ Load config from NVS (WiFi creds, printer BLE address)
  ├─ If not configured → start BLE config service, blink LED
  └─ If configured:
       ├─ Connect WiFi → NTP sync → got the date
       ├─ Idle (low power), BLE config still available
       └─ Button press:
            ├─ Connect to D12 over BLE (saved address)
            ├─ Render date as 1-bit bitmap
            ├─ Send AY/ESC print payload
            └─ Disconnect, return to idle
```

## BLE Configuration Service (Peripheral Role)

The ESP32 advertises a custom GATT service for phone-based setup.
Could use Espressif's WiFi provisioning library, or a simple custom service:

### Service UUID: `12345678-1234-1234-1234-123456789abc` (pick your own)

| Characteristic       | UUID  | Properties     | Format                        |
|-----------------------|-------|----------------|-------------------------------|
| WiFi Scan Trigger     | 0001  | Write          | Write `0x01` to start scan    |
| WiFi Scan Results     | 0002  | Read, Notify   | `SSID\0RSSI\n` per network    |
| WiFi Config           | 0003  | Write          | `SSID\0password` (UTF-8)      |
| WiFi Status           | 0004  | Read, Notify   | 1 byte: 0=none 1=connecting 2=ok 3=fail |
| Printer Scan Trigger  | 0005  | Write          | Write `0x01` to start scan    |
| Printer Scan Results  | 0006  | Read, Notify   | `name\0address\n` per device  |
| Printer Bind          | 0007  | Write          | BLE address string to save    |
| Printer Bound         | 0008  | Read           | Currently saved address       |
| Device Status         | 0009  | Read, Notify   | 0=setup 1=ready 2=printing 3=error |

### WiFi Discovery

When WiFi scan is triggered:
1. ESP32 calls `WiFi.scanNetworks()`
2. Returns list of SSIDs with RSSI (signal strength)
3. Writes results to WiFi Scan Results characteristic
4. Phone shows the list, user picks a network
5. Phone prompts for password
6. Phone writes `SSID\0password` to WiFi Config
7. ESP32 tries to connect, updates WiFi Status (notify)
8. On success, saves creds to NVS

### Printer Discovery

When printer scan is triggered:
1. ESP32 scans BLE for devices advertising service `0000ff00-...` or name containing "D12"
2. Collects results for ~10 seconds
3. Writes results to Printer Scan Results characteristic
4. Phone reads results, user picks one
5. Phone writes chosen address to Printer Bind
6. ESP32 saves to NVS

## D12 AY/ESC Print Protocol

Full protocol documented in `PROTOCOL.md`. Summary of what the ESP32 needs to send:

### BLE Connection

| Parameter | Value |
|-----------|-------|
| Service   | `0000ff00-0000-1000-8000-00805f9b34fb` |
| Write     | `0000ff02-0000-1000-8000-00805f9b34fb` |
| Notify    | `0000ff03-0000-1000-8000-00805f9b34fb` |
| Write Type | Write Without Response |
| Chunk Size | 1024 bytes, 5ms delay between chunks |

### Print Payload (concatenated binary)

```
10 FF FE 01                          // Enable
00 00 00 00 00 00 00 00 00 00 00 00  // Wakeup (12 null bytes)
1B 61 01                             // Location = CENTER
10 FF 10 00 03                       // Density = 3
10 FF 10 03 00                       // Paper type = gap labels

// Compressed image:
1F 00                                // Compressed image header
[w_hi] [w_lo]                        // Width in bytes (big-endian)
[h_hi] [h_lo]                        // Height in pixels (big-endian)
[len3] [len2] [len1] [len0]          // Compressed data length (big-endian, = len - 2)
[deflate data without 2-byte header] // zlib output starting at byte 2

// OR uncompressed image (recommended for small images):
1D 76 30                             // GS v 0
00                                   // Mode = normal
[w_lo] [w_hi]                        // Width in bytes (little-endian!)
[h_lo] [h_hi]                        // Height in pixels (little-endian!)
[raw bitmap data]                    // 1-bit MSB-first

1B 4A 0A                             // Line advance 10 dots
1D 0C                                // Gap detection
10 FF FE 45                          // Stop job (triggers print)
```

### Image Encoding

- 1-bit monochrome, MSB first (leftmost pixel = bit 7)
- Row-major, top to bottom
- Each row: `ceil(width / 8)` bytes, padded
- Black pixel = bit set to 1
- For compressed: use zlib deflate with wbits=10, strip first 2 bytes of output
- For uncompressed: send raw (no inversion needed for ESC mode)

**Recommendation: use uncompressed for simplicity.** The date label is tiny (~90x20 pixels = ~225 bytes). Not worth the complexity of zlib on ESP32 for this payload size.

## Date Rendering

### Font: Dot-Matrix Style

- Format: `yyyy/MM/dd` → e.g. `2026/05/01`
- Characters needed: `0123456789/`
- 11 characters total per date string

**Font design guidelines:**
- Monospace bitmap font, approximately 8px wide x 14-16px tall
- 1px gap between characters
- Designed to look like a 9-pin or 24-pin dot matrix printer output
- Strokes formed from individual dots rather than solid fills
- Slight roughness/texture is the goal

**Rendering approach:**
- Store font as `const uint8_t[]` in flash (PROGMEM)
- Each character: 1 byte per row x height rows
- To render a string: blit each character into a framebuffer
- Framebuffer is the final bitmap sent to the printer

### Label Dimensions

- D12 default label: 15mm x 40mm (width x height)
- DPI: 203
- Max print width: ~96 pixels (12mm)
- Available height: ~320 pixels (40mm)
- Date image: ~99px wide x 16px tall (fits width, centered on label height)

Consider rotating 90 degrees if you want the text along the long axis of the label.

## NVS Storage Layout

| Key             | Type   | Content                 |
|-----------------|--------|-------------------------|
| `wifi_ssid`     | string | WiFi SSID               |
| `wifi_pass`     | string | WiFi password           |
| `printer_addr`  | string | D12 BLE address         |
| `configured`    | u8     | 0=no 1=yes              |

## Dependencies (Arduino)

- `NimBLE-Arduino` — BLE peripheral + central simultaneously
- `WiFi.h` — built-in ESP32 WiFi
- `time.h` — NTP via `configTime()` (built-in, no library needed)
- `Preferences.h` — NVS wrapper (built-in)
- No graphics library needed — just manual bitmap blitting

## State Machine

```
BOOT
  |
  |--[not configured]-->  CONFIG_MODE
  |                        - Advertising BLE config service
  |                        - LED blinking
  |                        - Waiting for WiFi + printer setup
  |                        |
  |                        +--[configured]--> READY
  |
  +--[configured]-->  WIFI_CONNECT
                       |
                       |--[connected]--> NTP_SYNC --> READY
                       |                              - LED solid
                       |                              - BLE config still available
                       |                              - Waiting for button
                       |                              |
                       |                              +--[button press]--> PRINTING
                       |                                                   - Connect D12
                       |                                                   - Render + send
                       |                                                   - Disconnect
                       |                                                   +--> READY
                       |
                       +--[failed]--> CONFIG_MODE
```

## Query Commands (Optional, for status display in config app)

| Purpose    | Bytes          | Response             |
|------------|----------------|----------------------|
| Version    | `10 FF 20 F1`  | ASCII e.g. `V1.0.4`  |
| Battery    | `10 FF 50 F1`  | [charging, level%]   |
| State      | `10 FF 4F F1`  | Status bytes         |

## Web BLE Configuration App (SPA)

A single-page web app for configuring the ESP32 over Bluetooth.
No install, works on any device with Chrome (desktop or mobile).
Can be hosted on GitHub Pages or served locally.

### Tech Stack

- Vanilla HTML/CSS/JS (no framework needed — it's ~3 screens)
- Web Bluetooth API (`navigator.bluetooth`)
- No backend — everything happens client-side over BLE

### Web Bluetooth Connection

```js
const device = await navigator.bluetooth.requestDevice({
  filters: [{ services: ['12345678-1234-1234-1234-123456789abc'] }],
  // or filter by name prefix:
  // filters: [{ namePrefix: 'DatePrinter' }],
});
const server = await device.gatt.connect();
const service = await server.getPrimaryService('12345678-1234-1234-1234-123456789abc');
// Then get characteristics by UUID...
```

### UI Flow

```
+-----------------------------------+
|  [Connect to DatePrinter]         |   <-- requestDevice() prompt
+-----------------+-----------------+
                  |
+-----------------v-----------------+
|  WiFi Setup                       |
|                                   |
|  [Scan Networks]                  |   <-- write 0x01 to WiFi Scan Trigger
|                                   |
|  +---------------------------+    |
|  | MyNetwork        -42 dB  | <- |   <-- read WiFi Scan Results
|  | Neighbors5G      -67 dB  |    |
|  | IoTNet           -71 dB  |    |
|  +---------------------------+    |
|                                   |
|  Password: [______________]       |
|  [Connect]                        |   <-- write SSID\0pass to WiFi Config
|                                   |
|  Status: * Connected              |   <-- subscribe to WiFi Status notify
+-----------------+-----------------+
                  |
+-----------------v-----------------+
|  Printer Setup                    |
|                                   |
|  [Scan for Printers]              |   <-- write 0x01 to Printer Scan Trigger
|                                   |
|  +---------------------------+    |
|  | D12_9038_BLE       [Bind] | <- |   <-- read Printer Scan Results
|  | D12_A4C2_BLE       [Bind] |    |
|  +---------------------------+    |
|                                   |
|  Bound: D12_9038_BLE              |   <-- read Printer Bound
+-----------------+-----------------+
                  |
+-----------------v-----------------+
|  Status                           |
|                                   |
|  WiFi: Connected (MyNetwork)      |
|  Printer: D12_9038_BLE            |
|  Device: Ready                    |   <-- subscribe to Device Status notify
|                                   |
|  [Print Test Label]               |   <-- optional: trigger a test print
|  [Reset Config]                   |
+-----------------------------------+
```

### Characteristic Interaction Pattern

```js
// Example: WiFi scan flow
const scanTrigger = await service.getCharacteristic(0x0001);
const scanResults = await service.getCharacteristic(0x0002);

// Subscribe to results notification
scanResults.addEventListener('characteristicvaluechanged', (e) => {
  const text = new TextDecoder().decode(e.target.value);
  // Parse "SSID\0RSSI\nSSID2\0RSSI2\n..."
  displayNetworks(text);
});
await scanResults.startNotifications();

// Trigger scan
await scanTrigger.writeValue(new Uint8Array([0x01]));
```

### BLE Data Chunking

BLE characteristics have a max value size (~512 bytes with negotiated MTU, often 20 bytes default).
If scan results exceed this:
- ESP32 sends multiple notifications, one per result
- Or paginate: write an offset to read more
- Simplest: one notification per scan result, with a `0x00` terminator notification when done

### Hosting

- **GitHub Pages** — push `index.html` to a repo, free HTTPS (required for Web Bluetooth)
- **Local** — `python -m http.server` won't work (needs HTTPS). Use `npx serve` or similar
- **Embedded in ESP32** — possible via ESPAsyncWebServer over WiFi, but adds complexity.
  Better to keep it separate.

### Browser Support

- Chrome (desktop + Android): Full support
- Edge: Full support
- Safari/iOS: Not supported (no Web Bluetooth). Users would need a native app or use a computer.
- Firefox: Not supported (behind a flag, unreliable)

### Styling

Keep it minimal — the whole app is a setup wizard you use once. A clean card-based layout
with a monospace/dot-matrix font for the header would be a nice thematic touch.

## Notes

- The D12 auto-sleeps quickly. The ESP32 should connect, print, and disconnect
  promptly. May need to retry connection if printer is asleep.
- BLE central + peripheral simultaneously works on ESP32 with NimBLE.
  The config service stays active even while connecting to the printer.
- For the dot-matrix font: search for "IBM PC 437" or "Epson FX-80" bitmap fonts
  for authentic reference. Or hand-design ~12 characters for maximum charm.
- Button debouncing: 50ms is fine for a physical button.
- Consider deep sleep between presses to save battery if running on USB power bank.
