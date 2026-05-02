#!/usr/bin/env python3
"""Convert font.bmp (330x44, 32bpp) to a C header for the ESP32 firmware.

Expects an 11-glyph horizontal strip: 0123456789/
Each glyph is 30px wide x 44px tall.

Output: ../firmware/include/font_data.h

Usage:
    python3 convert_font.py
"""

import struct
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
INPUT = os.path.join(SCRIPT_DIR, "font.bmp")
OUTPUT = os.path.join(SCRIPT_DIR, "..", "firmware", "include", "font_data.h")

GLYPH_W = 30
GLYPH_H = 44
NUM_GLYPHS = 11
BYTES_PER_ROW = (GLYPH_W + 7) // 8  # 4
THRESHOLD = 128
CHARS = "0123456789/"


def read_bmp(path):
    with open(path, "rb") as f:
        data = f.read()

    w = struct.unpack_from("<i", data, 18)[0]
    h = struct.unpack_from("<i", data, 22)[0]
    bpp = struct.unpack_from("<H", data, 28)[0]
    offset = struct.unpack_from("<I", data, 10)[0]

    top_down = h < 0
    h = abs(h)
    bytes_per_px = bpp // 8
    stride = ((w * bytes_per_px + 3) // 4) * 4

    pixels = []
    for y in range(h):
        row = []
        for x in range(w):
            px_offset = offset + y * stride + x * bytes_per_px
            b, g, r = data[px_offset], data[px_offset + 1], data[px_offset + 2]
            gray = (r + g + b) // 3
            row.append(1 if gray < THRESHOLD else 0)
        pixels.append(row)

    if not top_down:
        pixels.reverse()

    return pixels, w, h


def extract_glyph(pixels, index):
    x_start = index * GLYPH_W
    glyph = []
    for y in range(GLYPH_H):
        row_bytes = []
        for bi in range(BYTES_PER_ROW):
            byte_val = 0
            for bit in range(8):
                x = x_start + bi * 8 + bit
                if x < x_start + GLYPH_W:
                    byte_val |= pixels[y][x] << (7 - bit)
            row_bytes.append(byte_val)
        glyph.append(row_bytes)
    return glyph


def main():
    pixels, w, h = read_bmp(INPUT)
    assert w == GLYPH_W * NUM_GLYPHS, f"Expected width {GLYPH_W * NUM_GLYPHS}, got {w}"
    assert h == GLYPH_H, f"Expected height {GLYPH_H}, got {h}"

    lines = []
    lines.append("#pragma once")
    lines.append("")
    lines.append("#include <stdint.h>")
    lines.append("")
    lines.append(f"// Auto-generated from font.bmp by convert_font.py")
    lines.append(f"// {NUM_GLYPHS} glyphs: {CHARS}")
    lines.append(f"// Each glyph: {GLYPH_W}x{GLYPH_H}px, {BYTES_PER_ROW} bytes/row, {BYTES_PER_ROW * GLYPH_H} bytes/glyph")
    lines.append("")
    lines.append("namespace date_label {")
    lines.append("")
    lines.append(f"constexpr uint8_t kFontGlyphWidth = {GLYPH_W};")
    lines.append(f"constexpr uint8_t kFontGlyphHeight = {GLYPH_H};")
    lines.append(f"constexpr uint8_t kFontBytesPerRow = {BYTES_PER_ROW};")
    lines.append(f"constexpr uint8_t kFontNumGlyphs = {NUM_GLYPHS};")
    lines.append("")
    lines.append(f"// Glyph index: 0-9 = digits, 10 = '/'")
    lines.append(f"constexpr uint8_t kFontData[{NUM_GLYPHS}][{GLYPH_H * BYTES_PER_ROW}] = {{")

    for ci in range(NUM_GLYPHS):
        glyph = extract_glyph(pixels, ci)
        label = CHARS[ci]
        lines.append(f"  // '{label}'")
        lines.append("  {")
        for row in glyph:
            lines.append("    " + ", ".join(f"0x{b:02X}" for b in row) + ",")
        lines.append("  },")

    lines.append("};")
    lines.append("")
    lines.append("}  // namespace date_label")
    lines.append("")

    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, "w") as f:
        f.write("\n".join(lines))

    total = NUM_GLYPHS * GLYPH_H * BYTES_PER_ROW
    print(f"Wrote {OUTPUT} ({total} bytes of glyph data)")


if __name__ == "__main__":
    main()
