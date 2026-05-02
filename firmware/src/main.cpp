#include <Arduino.h>
#include <nvs_flash.h>

#include "app_config.h"
#include "ble_config_service.h"
#include "wifi_manager.h"

#ifndef PIO_UNIT_TESTING

namespace {

date_label::WifiManager wifiManager;
date_label::BleConfigService bleConfig;

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(200);

  Serial.println("date-label firmware booting");

  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES ||
      err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    nvs_flash_erase();
    nvs_flash_init();
  }

  wifiManager.Begin();
  bleConfig.Begin(wifiManager);
}

void loop() {
  bleConfig.Poll();
  delay(10);
}

#endif
