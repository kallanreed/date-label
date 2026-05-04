# How to Use the Date Label Printer

This is the quick-start flow for the current firmware and web UI.

## Before you start

- Power the ESP32 device.
- Open the web app on a browser that supports **Web Bluetooth**.
- Make sure you are close enough to the device and the D12 printer for BLE pairing.

## First-time setup

1. In the web app, tap **Connect** and choose the device named **`DatePrinter`**.
2. In **Config**, set your **WiFi** network so the device can reach NIST for time sync.
3. Set the **Printer** by scanning and binding your Labelnize / Nelko D12.
4. Set the **Time Zone** so the device can convert UTC into the local date.
5. Open **Label Preview** and tap **Refresh Preview** once the device has synced time.
6. Tap **Print Label** to print from the web UI.

## Normal use

After setup is saved, the device reconnects on boot. When the status LED turns **green**, you can:

- print from the web UI with **Print Label**
- press the physical button on the device to print the current date label

## Status colors

The RGB LED shows the device's current state:

| Color | Meaning |
|---|---|
| **Red** | Device is not configured yet |
| **Orange** | WiFi is configured, but not connected |
| **Yellow** | WiFi is connected, but time is not synced yet |
| **Blue** | Time is synced, but no printer is bound |
| **White** | A print is currently in progress |
| **Green** | Ready to print |

## If something looks wrong

- **Red**: finish initial setup in the web app.
- **Orange**: check WiFi credentials and signal strength.
- **Yellow**: wait for sync, then confirm WiFi internet access and timezone setup.
- **Blue**: bind a printer in the **Config** section.
- If preview says **Waiting for sync**, the device still does not have usable local time.
