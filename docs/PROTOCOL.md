# Labelnize D12 Thermal Label Printer - Protocol Documentation

Reverse engineered from Labelnize APK v4.7.2.

## Device Identity

| Field              | Value                                    |
|--------------------|------------------------------------------|
| Model              | D12                                      |
| FCC ID             | 2BDL3-D12                                |
| Manufacturer       | Xiamen AiYin Technology Co., Ltd.        |
| Brand              | Labelnize (also sold as Nelko)           |
| USB VID:PID        | 09c5:0200                                |
| USB Product Name   | "Printer"                                |
| USB Serial         | 389015CE1703                             |
| IEEE 1284 CMD      | XPP, XL                                  |
| DPI                | 203                                      |
| Max Print Width    | 12mm (~96 dots)                          |
| Default Label      | 15mm x 40mm white gap labels             |
| Default Gap        | 8mm                                      |
| Paper Types        | Gap (0), Continuous (1)                  |
| Paper Length Range  | 10-1000mm                                |
| Max Copies/Job     | 50                                       |
| Density Model      | 1 (manual)                               |
| Command Protocol   | 5 (AY Command - AiYin proprietary)       |
| Firmware Update    | Type 3 (AIYIN OTA)                       |
| Encryption         | None (isEncrypt=0)                       |
| Battery Threshold  | 10%                                      |

## Supported Command Languages

The IEEE 1284 Device ID advertises two command languages:

- **XPP** - A raster page description language implemented in the native `libPrinterNative.so`.
  Wire format (from strings analysis):
  ```
  Event=StartOfPrintJob;Sides=OneSided;MediaType=Plain;PaperSource=auto;
  MediaSize=printer_label_size;Resolution=200x200;
  Origin.Top=%dmm;Origin.Left=%dmm;
  RasterObject.ColorSpace=Mono;RasterObject.Compression=GZIPTok;
  RasterObject.Width=%d;RasterObject.Height=%d;RasterObject.Stride=%d;
  RasterObject.Colorants=000000,000000;
  RasterObject.Data#%d=<gzip_compressed_raster_line>
  ;Event=EndOfPage;Event=EndOfJob;
  ```
  Primarily used over USB. Raster data is gzip-compressed mono bitmap lines.

- **XL** - Maps to TSPL (described below). Used over BLE.

## Native Compression Libraries

The native `libPrinterNative.so` provides hardware-accelerated compression:
- `Compress.codeTSPL(byte[])` - TSPL bitmap compression
- `Compress.codeESC(byte[])` - ESC bitmap compression
- `Compress.codeLihu(byte[])` - LiHu compression
- `Compress.codeCPCL(byte[])` - CPCL compression
- `PrintNative.analysisData(byte[])` - Response parsing

## Transport: Bluetooth Low Energy (BLE)

| Parameter              | Value                                          |
|------------------------|------------------------------------------------|
| Service UUID           | `0000ff00-0000-1000-8000-00805f9b34fb`         |
| Write Characteristic   | `0000ff02-0000-1000-8000-00805f9b34fb`         |
| Read Characteristic    | `0000ff01-0000-1000-8000-00805f9b34fb`         |
| Notify Characteristic  | `0000ff03-0000-1000-8000-00805f9b34fb`         |
| MTU                    | 512 (negotiated)                               |
| Write Type             | Write Without Response                         |
| Chunk Size             | 1024 bytes (app splits large payloads)         |
| Chunk Delay            | 5 ms between chunks                            |

## Primary Command Protocol: AY/ESC Binary (Command Type 5)

The D12 uses the **AY (AiYin) binary protocol**, NOT raw TSPL text.
All commands are binary byte sequences, concatenated and sent as a single payload.

### Query Commands

Format: `[0x10] [0xFF] [CMD_ID] [0xF1]`

| Command    | Bytes              | Response                           |
|------------|--------------------|------------------------------------|
| Version    | `10 FF 20 F1`      | ASCII string, e.g. `V1.0.4`       |
| Battery    | `10 FF 50 F1`      | 2 bytes: [charging_flag, level%]   |
| State      | `10 FF 4F F1`      | Status bytes                       |
| Info       | `10 FF 5A F1`      | Device metadata                    |

### Print Commands

| Command      | Header Bytes         | Payload              |
|--------------|----------------------|----------------------|
| Enable       | `10 FF FE 01`        | (none)               |
| Wakeup       | 12x `00`             | (none)               |
| Location     | `1B 61`              | 1 byte: 0=L 1=C 2=R |
| Density      | `10 FF 10 00`        | 1 byte: density val  |
| Paper Type   | `10 FF 10 03`        | 1 byte: type (0-5)   |
| Line Dot     | `1B 4A`              | 1 byte: dot count    |
| Position     | `1D 0C`              | (none) gap detection |
| Stop/Print   | `10 FF FE 45`        | (none) triggers print|

Paper types: 0=gap, 1=continuous, 2=no-dry adhesive, 3=hole, 4=tattoo, 5=tattoo wrinkles

### Image Command

#### Uncompressed: `1D 76 30` (GS v 0)
```
1D 76 30 [mode] [w_lo w_hi] [h_lo h_hi] [raw_bitmap_data]
```
- mode: 0=normal, 1=double-width, 2=double-height, 3=double-both
- width: bytes per row = ceil(px_width / 8), **little-endian**
- height: pixels, **little-endian**

#### Compressed: `1F 00`
```
1F 00 [w_hi w_lo] [h_hi h_lo] [len_3 len_2 len_1 len_0] [compressed_data]
```
- width/height: **big-endian** (note: opposite of uncompressed!)
- length: 4-byte **big-endian**, equals `len(compressed) - 2`
- data: zlib output with **2-byte header stripped** (starts at byte 2)

## Image Encoding

### Pixel-to-Bitmap Conversion

1. Convert each pixel to grayscale: `gray = (R + G + B) / 3`
2. Threshold: if `gray < 190`, pixel is **black** (bit = 1)
3. Pixels with value 0xFFFFFFFF (-1 / white) are skipped (bit stays 0)
4. Bit ordering: **MSB first** (leftmost pixel = bit 7)
5. Row padding: each row is ceil(width / 8) bytes
6. Row-major order: top to bottom, left to right

### Compression

Zlib deflate with:
- Level: -1 (default)
- Window bits: 10 (1024-byte window)
- Method: 8 (deflate)

Output: strip first 2 bytes (zlib header) before sending.

## Complete AY Print Sequence

All commands concatenated into a single binary payload, sent in 1024-byte chunks:

```
10 FF FE 01                          # Enable
00 00 00 00 00 00 00 00 00 00 00 00  # Wakeup (12 null bytes)
1B 61 01                             # Location = CENTER
10 FF 10 00 <density>                # Set density
10 FF 10 03 <paper_type>             # Set paper type
1F 00 <w_hi> <w_lo> <h_hi> <h_lo>   # Compressed image header
  <len_3> <len_2> <len_1> <len_0>   #   data length (4 bytes BE)
  <compressed_bitmap_data>           #   deflate data (zlib header stripped)
1B 4A 0A                             # Line advance 10 dots
1D 0C                                # Gap/position detect
10 FF FE 45                          # Stop job (triggers print)
```

## TSPL Protocol (Alternative, for other models)

Some printers in the Labelnize family use raw TSPL text commands instead.
The D12 does NOT use TSPL — it uses the AY/ESC binary protocol above.
TSPL details retained here for reference with other models (command types 0, 7).

Commands are plain text encoded as GBK, terminated with `\r\n`.
Key commands: CLS, SIZE, GAP, DIRECTION, REFERENCE, DENSITY, BITMAP, PRINT.

## USB Transport

The printer also works over USB as a standard printer class device:
- Product name filter: app matches devices with `getProductName() == "Printer"`
- USB speed: Full Speed (12 Mbps)
- Uses USB bulk transfers (abstracted in native code)
- Same TSPL/XPP command protocol over USB

## Cloud API

Base URL: `https://app.labelnize.com`

| Endpoint                                | Method | Purpose                      |
|-----------------------------------------|--------|------------------------------|
| `/api/templateVip/getDeviceList`        | GET    | Get all device configs       |
| `/api/firmware/verify2`                 | POST   | Check for firmware updates   |
| `/api/firmware/download`                | POST   | Get firmware download URL    |
| `/api/firmware/isNoRfidError`           | POST   | RFID error check             |
| `/api/home/getMenuInitializeConfig`     | GET    | App home config              |
| `/api/label/getTypeList/{dev}`          | GET    | Label types for device       |

### Firmware Update API

**verify2 request:**
```json
{
  "dev": "D12",
  "firmwareName": "<current_fw_version>",
  "hardwareName": "<current_hw_version>",
  "mac": "<bluetooth_mac>"
}
```
firmwareName and hardwareName are queried from the printer over BLE first.

**Response (FirmwareVO2):**
```json
{
  "hasNewVersion": true,
  "firmwareDownloadUrl": "https://...",
  "md5": "<checksum>",
  "name": "<version>",
  "forceUpdate": false,
  "content": "<changelog>"
}
```

### Firmware Update Types
- 0: NORMAL
- 1: JIELI (JieLi BLE OTA, service `0000ae00-...`)
- 2: SANZANG (Pocket printer OTA)
- **3: AIYIN** (D12 uses this)
- 4: YIN_XIANG

## Command Protocol IDs (from device config API)

| ID | Name              | Description                |
|----|-------------------|----------------------------|
| 0  | AfterSend         | Print after full send      |
| 1  | FakeESC           | ESC-like wrapper           |
| 2  | ESC               | Standard ESC/POS           |
| 3  | PL70e             | PL70e model (normal/OEM)   |
| 4  | YX                | YinXiang command set       |
| **5** | **AY**         | **AiYin (D12 uses this)**  |
| 6  | Pocket            | Pocket printer command     |
| 7  | Special           | Special model              |
| 8  | YX 2-inch         | YinXiang 2-inch variant    |
| 9  | YX 4-inch         | YinXiang 4-inch variant    |
