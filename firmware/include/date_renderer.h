#pragma once

#include <stddef.h>
#include <stdint.h>

namespace date_label {

// Renders a date string (e.g. "2026/05/02") as a 1-bit bitmap for the D12
// printer. Glyphs are composited horizontally, rotated 90° CW, and centered
// within kMaxPrintWidthPx (96px). The caller must free the returned buffer
// with delete[]. Returns nullptr on invalid input.
uint8_t* RenderDateBitmap(const char* date,
                          uint16_t& outWidth, uint16_t& outHeight);

}  // namespace date_label
