#include "date_renderer.h"

#include <string.h>

#include "app_config.h"
#include "font_data.h"

namespace date_label {

static int GlyphIndex(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c == '/') return 10;
  return -1;
}

uint8_t* RenderDateBitmap(const char* date,
                          uint16_t& outWidth, uint16_t& outHeight) {
  size_t len = strlen(date);
  if (len == 0) return nullptr;

  // Validate all characters.
  for (size_t i = 0; i < len; i++) {
    if (GlyphIndex(date[i]) < 0) return nullptr;
  }

  // Text dimensions before rotation.
  uint16_t textWidth = len * kFontGlyphWidth;   // e.g. 300 for 10 chars
  uint16_t textHeight = kFontGlyphHeight;       // 44

  // Output: rotated 90° CW, centered in printer width.
  outWidth = config::kMaxPrintWidthPx;           // 96
  outHeight = textWidth;                         // 300
  uint16_t outBytesPerRow = outWidth / 8;        // 12
  size_t outSize = outBytesPerRow * outHeight;

  uint8_t* buf = new uint8_t[outSize];
  memset(buf, 0, outSize);

  uint16_t offsetPx = (outWidth - textHeight) / 2;  // (96-44)/2 = 26

  // Directly composite + rotate + center in one pass.
  // 90° CW maps input(ix, iy) → output(textHeight-1-iy, ix).
  // We iterate output pixels in the non-padded region.
  for (uint16_t oy = 0; oy < outHeight; oy++) {
    for (uint16_t ox = 0; ox < textHeight; ox++) {
      // Reverse the rotation to find the source pixel.
      uint16_t ix = oy;                     // x in horizontal text
      uint16_t iy = textHeight - 1 - ox;    // y in horizontal text

      // Look up pixel in font data.
      size_t glyphIdx = ix / kFontGlyphWidth;
      uint8_t pixInGlyph = ix % kFontGlyphWidth;
      int fontIdx = GlyphIndex(date[glyphIdx]);
      size_t fontOffset = iy * kFontBytesPerRow + pixInGlyph / 8;
      uint8_t bitInByte = 7 - (pixInGlyph % 8);
      bool pixel = (kFontData[fontIdx][fontOffset] >> bitInByte) & 1;

      if (pixel) {
        uint16_t dx = ox + offsetPx;
        buf[oy * outBytesPerRow + dx / 8] |= (1 << (7 - (dx % 8)));
      }
    }
  }

  return buf;
}

}  // namespace date_label
