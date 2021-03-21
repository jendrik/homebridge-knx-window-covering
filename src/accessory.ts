import { AccessoryConfig, AccessoryPlugin, CharacteristicValue, Service } from 'homebridge';

import { Datapoint } from 'knx';

import { PLUGIN_NAME, PLUGIN_VERSION, PLUGIN_DISPLAY_NAME } from './settings';

import { WindowCoveringPlatform } from './platform';

import SunCalc from 'suncalc';

export class WindowCoveringAccessory implements AccessoryPlugin {
  private readonly uuid_base: string;
  private readonly name: string;
  private readonly displayName: string;

  private readonly dp_set_target_horizontal_tilt_angle: Datapoint;

  private readonly windowCoveringService: Service;
  private readonly informationService: Service;

  constructor(
    private readonly platform: WindowCoveringPlatform,
    private readonly config: AccessoryConfig,
  ) {

    this.name = config.name;
    this.uuid_base = platform.uuid.generate(PLUGIN_NAME + '-' + this.name + '-' + config.listen_current_position);
    this.displayName = this.uuid_base;

    this.informationService = new platform.Service.AccessoryInformation()
      .setCharacteristic(platform.Characteristic.Name, this.name)
      .setCharacteristic(platform.Characteristic.Identify, this.name)
      .setCharacteristic(platform.Characteristic.Manufacturer, '@jendrik')
      .setCharacteristic(platform.Characteristic.Model, PLUGIN_DISPLAY_NAME)
      .setCharacteristic(platform.Characteristic.SerialNumber, this.displayName)
      .setCharacteristic(platform.Characteristic.FirmwareRevision, PLUGIN_VERSION);

    this.windowCoveringService = new platform.Service.WindowCovering(this.name);
    this.windowCoveringService.getCharacteristic(platform.Characteristic.StatusActive).updateValue(true);

    // set default position to open
    this.windowCoveringService.getCharacteristic(platform.Characteristic.TargetPosition).updateValue(100);

    const dp_listen_move = new Datapoint({
      ga: config.listen_move,
      dpt: 'DPT1.008',
      autoread: true,
    }, platform.connection);

    const dp_set_stop = new Datapoint({
      ga: config.set_stop,
      dpt: 'DPT1.007',
    }, platform.connection);

    const dp_listen_current_position = new Datapoint({
      ga: config.listen_current_position,
      dpt: 'DPT5.001',
      autoread: true,
    }, platform.connection);

    const dp_set_target_position = new Datapoint({
      ga: config.set_target_position,
      dpt: 'DPT5.001',
    }, platform.connection);

    const dp_listen_current_horizontal_tilt_angle = new Datapoint({
      ga: config.listen_current_horizontal_tilt_angle,
      dpt: 'DPT5.001',
      autoread: true,
    }, platform.connection);

    const dp_listen_obstruction_detected = new Datapoint({
      ga: config.listen_obstruction_detected,
      dpt: 'DPT6',
      autoread: true,
    }, platform.connection);

    this.dp_set_target_horizontal_tilt_angle = new Datapoint({
      ga: config.set_target_horizontal_tilt_angle,
      dpt: 'DPT5',
    }, platform.connection);

    dp_listen_move.on('change', (oldValue: boolean, newValue: boolean) => {
      platform.log.info(`Move: ${newValue}`);
      switch (newValue) {
        case false: // up
          this.windowCoveringService.getCharacteristic(platform.Characteristic.TargetPosition).updateValue(100);
          this.windowCoveringService.getCharacteristic(platform.Characteristic.PositionState)
            .updateValue(platform.Characteristic.PositionState.INCREASING);
          break;

        case true: // down
          this.windowCoveringService.getCharacteristic(platform.Characteristic.TargetPosition).updateValue(0);
          this.windowCoveringService.getCharacteristic(platform.Characteristic.PositionState)
            .updateValue(platform.Characteristic.PositionState.DECREASING);
          break;
      }
    });

    dp_set_stop.on('change', (oldValue: boolean, newValue: boolean) => {
      platform.log.info(`Step/Stop: ${newValue}`);
    });

    dp_listen_current_position.on('change', (oldValue: number, newValue: number) => {
      const current_position = 100 - newValue;
      platform.log.info(`CurrentPosition: ${current_position}`);
      this.windowCoveringService.getCharacteristic(platform.Characteristic.CurrentPosition)
        .updateValue(current_position);
      this.windowCoveringService.getCharacteristic(platform.Characteristic.PositionState)
        .updateValue(platform.Characteristic.PositionState.STOPPED);
      this.windowCoveringService.getCharacteristic(platform.Characteristic.TargetPosition)
        .updateValue(current_position);

      // completely close, wait and re-calculate sun based position
      this.dp_set_target_horizontal_tilt_angle.write(255);
      setTimeout(async () => {
        this.updateTilt();
      }, 2 * 1000);
    });

    dp_listen_current_horizontal_tilt_angle.on('change', (oldValue: number, newValue: number) => {
      const converted_value = ((100.0 - newValue) - 50.0) / 50.0 * 90.0;
      platform.log.info(`CurrentHorizontalTiltAngle: ${newValue} - ${converted_value}`);
      this.windowCoveringService.getCharacteristic(platform.Characteristic.CurrentHorizontalTiltAngle).updateValue(converted_value);
      this.windowCoveringService.getCharacteristic(platform.Characteristic.TargetHorizontalTiltAngle).updateValue(converted_value);
    });

    dp_listen_obstruction_detected.on('change', (oldValue: number, newValue: number) => {
      const WIND = 1 << 5;
      const RAIN = 1 << 4;
      const FROST = 1 << 3;
      const FORCED = 1 << 2;
      const DISABLED = 1 << 1;
      const obstruction_detected =
        ((newValue & WIND) || (newValue & RAIN) || (newValue & FROST) || (newValue & FORCED) || (newValue & DISABLED)) > 0;

      platform.log.info(`ObstructionDetected: ${newValue} - ${obstruction_detected}`);
      this.windowCoveringService.getCharacteristic(platform.Characteristic.ObstructionDetected).updateValue(obstruction_detected);
    });

    this.windowCoveringService.getCharacteristic(platform.Characteristic.HoldPosition)
      .onSet(async (value: CharacteristicValue) => {
        platform.log.info(`HoldPosition: ${value}`);
        dp_set_stop.write(true);

        // completely close, wait and re-calculate sun based position
        this.dp_set_target_horizontal_tilt_angle.write(255);
        setTimeout(async () => {
          this.updateTilt();
        }, 2 * 1000);
      });

    this.windowCoveringService.getCharacteristic(platform.Characteristic.TargetPosition)
      .onSet(async (value: CharacteristicValue) => {
        const target_position = 100 - Number(value);
        platform.log.info(`TargetPosition: ${value}`);
        dp_set_target_position.write(target_position);

        if (Number(this.windowCoveringService.getCharacteristic(platform.Characteristic.CurrentPosition).value) > target_position) {
          this.windowCoveringService.getCharacteristic(platform.Characteristic.PositionState)
            .updateValue(platform.Characteristic.PositionState.DECREASING);
        } else {
          this.windowCoveringService.getCharacteristic(platform.Characteristic.PositionState)
            .updateValue(platform.Characteristic.PositionState.INCREASING);
        }
      });

    this.windowCoveringService.getCharacteristic(platform.Characteristic.TargetHorizontalTiltAngle)
      .onSet(async (value: CharacteristicValue) => {
        const converted_value = (180.0 - (Number(value) + 90.0)) / 180.0 * 255.0;
        platform.log.info(`TargetHorizontalTiltAngle: ${value} - ${converted_value}`);
        this.dp_set_target_horizontal_tilt_angle.write(converted_value);
      });

    // update tilt every minute
    setInterval(async () => {
      this.updateTilt();
    }, 60 * 1000);
  }

  getServices(): Service[] {
    return [
      this.informationService,
      this.windowCoveringService,
    ];
  }

  updateTilt() {
    const sunPos = SunCalc.getPosition(new Date(), this.platform.latitude, this.platform.longitude);

    let hk_value = -90;
    let knx_position = 255;
    if (sunPos.altitude >= 0) {
      const beta = (Math.PI - (Math.PI / 2 - sunPos.altitude) - Math.asin(70.0 / 80.0 * Math.sin(Math.PI / 2 - sunPos.altitude)))
        * (180.0 / Math.PI);
      knx_position = Math.round(Math.max(255 - (beta * 100 / 90), 128.0));
      hk_value = (knx_position - 128) / 128 * -90;
    }

    this.dp_set_target_horizontal_tilt_angle.write(knx_position);
    this.windowCoveringService.getCharacteristic(this.platform.Characteristic.TargetHorizontalTiltAngle).updateValue(hk_value);
  }
}
