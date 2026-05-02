#!/usr/bin/env python3
"""
D12 Thermal Label Printer - BLE Driver (AY Protocol)

Reverse engineered from Labelnize APK v4.7.2.
Uses the AY/ESC binary protocol over BLE.

Requirements:
    pip install bleak Pillow
"""

import asyncio
import zlib
import struct
import argparse

from bleak import BleakClient, BleakScanner
from PIL import Image

# ── BLE UUIDs ──────────────────────────────────────────────────────────────
SERVICE_UUID = "0000ff00-0000-1000-8000-00805f9b34fb"
CHAR_WRITE   = "0000ff02-0000-1000-8000-00805f9b34fb"
CHAR_NOTIFY  = "0000ff03-0000-1000-8000-00805f9b34fb"

# ── Protocol constants ─────────────────────────────────────────────────────
CHUNK_SIZE = 1024
CHUNK_DELAY = 0.005  # 5ms between chunks
DEFAULT_THRESHOLD = 190
DEFAULT_DENSITY = 3

# ── AY ESC Command Headers ────────────────────────────────────────────────
CMD_ENABLE    = bytes([0x10, 0xFF, 0xFE, 0x01])
CMD_WAKEUP    = bytes(12)  # 12 null bytes
CMD_LOCATION  = bytes([0x1B, 0x61])       # + 1 byte: 0=left, 1=center, 2=right
CMD_THICKNESS = bytes([0x10, 0xFF, 0x10, 0x00])  # + 1 byte: density value
CMD_PAPER_TYPE= bytes([0x10, 0xFF, 0x10, 0x03])  # + 1 byte: paper type
CMD_LINE_DOT  = bytes([0x1B, 0x4A])       # + 1 byte: dot count
CMD_POSITION  = bytes([0x1D, 0x0C])       # gap/label detection
CMD_STOP_JOB  = bytes([0x10, 0xFF, 0xFE, 0x45])  # print trigger

# Image headers
IMG_UNCOMPRESSED = bytes([0x1D, 0x76, 0x30])  # GS v 0
IMG_COMPRESSED   = bytes([0x1F, 0x00])

# Query commands
CMD_VERSION   = bytes([0x10, 0xFF, 0x20, 0xF1])
CMD_BATTERY   = bytes([0x10, 0xFF, 0x50, 0xF1])
CMD_STATE     = bytes([0x10, 0xFF, 0x4F, 0xF1])
CMD_INFO      = bytes([0x10, 0xFF, 0x5A, 0xF1])

# Paper types
PAPER_GAP        = 0  # Gap/label paper (default for D12)
PAPER_CONTINUOUS  = 1
PAPER_NO_DRY     = 2
PAPER_HOLE       = 3
PAPER_TATTOO     = 4


def image_to_bitmap(img: Image.Image, threshold: int = DEFAULT_THRESHOLD) -> tuple[bytes, int, int]:
    """Convert a PIL Image to 1-bit printer bitmap.

    Returns (bitmap_bytes, width_pixels, height_pixels).
    MSB first: leftmost pixel = bit 7.
    Pixel with grayscale < threshold = black (bit set to 1).
    """
    img = img.convert("RGB")
    width, height = img.size
    pixels = img.load()

    bytes_per_row = (width + 7) // 8
    bitmap = bytearray(height * bytes_per_row)

    for y in range(height):
        for x in range(width):
            r, g, b = pixels[x, y]
            gray = (r + g + b) // 3
            if gray < threshold:
                byte_idx = y * bytes_per_row + (x // 8)
                bit_idx = 7 - (x % 8)
                bitmap[byte_idx] |= (1 << bit_idx)

    return bytes(bitmap), width, height


def compress_bitmap(data: bytes) -> bytes:
    """Compress bitmap with zlib deflate (wbits=10).

    Returns the full zlib output. The caller strips the 2-byte header
    before sending to the printer.
    """
    compressor = zlib.compressobj(level=-1, method=zlib.DEFLATED, wbits=10)
    compressed = compressor.compress(data)
    compressed += compressor.flush(zlib.Z_FINISH)
    return compressed


def build_image_command(bitmap_data: bytes, width: int, height: int,
                        compress: bool = True) -> bytes:
    """Build an AY ESC image command.

    Compressed:   1F 00 [w_hi w_lo] [h_hi h_lo] [len(4 bytes BE)] [data without 2-byte zlib header]
    Uncompressed: 1D 76 30 [mode] [w_lo w_hi] [h_lo h_hi] [raw data]
    """
    width_bytes = (width + 7) // 8

    if compress:
        compressed = compress_bitmap(bitmap_data)
        # Strip 2-byte zlib header, send rest
        payload = compressed[2:]
        data_len = len(payload)
        header = IMG_COMPRESSED
        header += struct.pack(">HH", width_bytes, height)       # big-endian
        header += struct.pack(">I", data_len)                     # 4-byte BE length
        return header + payload
    else:
        header = IMG_UNCOMPRESSED
        header += bytes([0x00])  # mode=NORMAL
        header += struct.pack("<HH", width_bytes, height)        # little-endian
        return header + bitmap_data


def build_print_payload(bitmap_data: bytes, width: int, height: int,
                        density: int = DEFAULT_DENSITY,
                        compress: bool = True,
                        paper_type: int = PAPER_GAP,
                        location: int = 1,
                        line_dot: int = 10) -> bytes:
    """Build the complete AY print payload (all commands concatenated).

    Sequence: ENABLE → WAKEUP → LOCATION → THICKNESS → PAPER_TYPE → IMAGE → LINE_DOT → POSITION → STOP_JOB
    """
    parts = []

    # 1. Enable
    parts.append(CMD_ENABLE)

    # 2. Wakeup (12 null bytes)
    parts.append(CMD_WAKEUP)

    # 3. Location (center=1)
    parts.append(CMD_LOCATION + bytes([location]))

    # 4. Density/thickness
    parts.append(CMD_THICKNESS + bytes([density]))

    # 5. Paper type
    parts.append(CMD_PAPER_TYPE + bytes([paper_type]))

    # 6. Image data
    parts.append(build_image_command(bitmap_data, width, height, compress))

    # 7. Line dot advance
    parts.append(CMD_LINE_DOT + bytes([line_dot]))

    # 8. Position (gap detection)
    parts.append(CMD_POSITION)

    # 9. Stop job (triggers print)
    parts.append(CMD_STOP_JOB)

    return b"".join(parts)


class D12Printer:
    """BLE driver for the D12 thermal label printer (AY protocol)."""

    def __init__(self, address: str):
        self.address = address
        self.client = BleakClient(address)
        self._responses: list[bytes] = []
        self._notify_event = asyncio.Event()

    def _on_notify(self, sender, data: bytearray):
        self._responses.append(bytes(data))
        self._notify_event.set()

    async def connect(self):
        await self.client.connect()
        await self.client.start_notify(CHAR_NOTIFY, self._on_notify)
        print(f"Connected to {self.address} (MTU={self.client.mtu_size})")

    async def disconnect(self):
        await self.client.disconnect()
        print("Disconnected")

    async def _write_chunked(self, data: bytes):
        """Write data in 1024-byte chunks with 5ms delay."""
        for offset in range(0, len(data), CHUNK_SIZE):
            chunk = data[offset : offset + CHUNK_SIZE]
            await self.client.write_gatt_char(CHAR_WRITE, chunk, response=False)
            if offset + CHUNK_SIZE < len(data):
                await asyncio.sleep(CHUNK_DELAY)

    async def _query(self, cmd: bytes, timeout: float = 3.0) -> bytes:
        """Send a query command and collect responses."""
        self._responses.clear()
        self._notify_event.clear()
        await self.client.write_gatt_char(CHAR_WRITE, cmd, response=False)
        # Collect responses for a bit (printer may send multiple notifications)
        try:
            await asyncio.wait_for(self._notify_event.wait(), timeout)
            await asyncio.sleep(0.3)  # wait for any additional data
        except asyncio.TimeoutError:
            pass
        return b"".join(self._responses)

    async def get_version(self) -> str:
        resp = await self._query(CMD_VERSION)
        # Response is ASCII like "V1.0.4" or binary
        try:
            text = resp.decode("ascii", errors="ignore")
            if text and any(c.isdigit() for c in text):
                return text.strip()
        except:
            pass
        return resp.hex(" ")

    async def get_battery(self) -> tuple[bool, int]:
        """Returns (is_charging, level_percent)."""
        resp = await self._query(CMD_BATTERY)
        if len(resp) >= 2:
            return (resp[0] == 0x02, resp[1])
        return (False, -1)

    async def get_state(self) -> bytes:
        return await self._query(CMD_STATE)

    async def get_info(self) -> bytes:
        return await self._query(CMD_INFO)

    async def print_image(
        self,
        img: Image.Image,
        density: int = DEFAULT_DENSITY,
        threshold: int = DEFAULT_THRESHOLD,
        compress: bool = True,
        paper_type: int = PAPER_GAP,
    ):
        """Print an image.

        Args:
            img: PIL Image to print.
            density: Print darkness (0-15).
            threshold: Grayscale threshold (0-255). Lower = less black.
            compress: Use zlib compression.
            paper_type: 0=gap, 1=continuous, 2=no-dry, 3=hole, 4=tattoo.
        """
        bitmap_data, width, height = image_to_bitmap(img, threshold)
        payload = build_print_payload(
            bitmap_data, width, height,
            density=density, compress=compress, paper_type=paper_type,
        )
        print(f"Sending print job: {width}x{height}px, {len(payload)} bytes total")
        await self._write_chunked(payload)
        print("Print job sent!")


async def scan(timeout: float = 10.0):
    """Scan for D12 printers."""
    print(f"Scanning for printers ({timeout}s)...")
    devices = await BleakScanner.discover(timeout=timeout, return_adv=True)
    found = []
    for d, adv in devices.values():
        name = d.name or adv.local_name or ""
        uuids = [str(u).lower() for u in (adv.service_uuids or [])]
        is_printer = SERVICE_UUID in uuids or any(
            kw in name.lower() for kw in ["d12", "label", "print", "nelko"]
        )
        if name:
            marker = " <-- PRINTER" if is_printer else ""
            print(f"  {name} ({d.address}) RSSI={adv.rssi}{marker}")
            if is_printer:
                found.append(d)
    if not found:
        print("No printers found.")
    return found


async def main():
    parser = argparse.ArgumentParser(description="D12 Label Printer Driver (AY Protocol)")
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("scan", help="Scan for BLE printers")

    info_p = sub.add_parser("info", help="Query printer info")
    info_p.add_argument("address", help="BLE address (UUID on macOS)")

    print_p = sub.add_parser("print", help="Print an image")
    print_p.add_argument("address", help="BLE address")
    print_p.add_argument("image", help="Image file path")
    print_p.add_argument("--density", type=int, default=3, help="Density 0-15 (default 3)")
    print_p.add_argument("--threshold", type=int, default=190, help="B/W threshold 0-255")
    print_p.add_argument("--no-compress", action="store_true", help="Disable compression")
    print_p.add_argument("--paper", type=int, default=0,
                         help="Paper type: 0=gap, 1=continuous")

    args = parser.parse_args()

    if args.cmd == "scan":
        await scan()

    elif args.cmd == "info":
        p = D12Printer(args.address)
        await p.connect()
        try:
            # Send all queries, then read responses
            # (responses may arrive out of order, so query one at a time)
            ver = await p.get_version()
            print(f"  Firmware: {ver}")
            charging, level = await p.get_battery()
            print(f"  Battery:  {level}% {'(charging)' if charging else ''}")
            state = await p.get_state()
            print(f"  State:    {state.hex(' ')}")
            info = await p.get_info()
            print(f"  Info:     {info.hex(' ')}")
        finally:
            await p.disconnect()

    elif args.cmd == "print":
        img = Image.open(args.image)
        p = D12Printer(args.address)
        await p.connect()
        try:
            await p.print_image(
                img,
                density=args.density,
                threshold=args.threshold,
                compress=not args.no_compress,
                paper_type=args.paper,
            )
        finally:
            await p.disconnect()

    else:
        parser.print_help()


if __name__ == "__main__":
    asyncio.run(main())
