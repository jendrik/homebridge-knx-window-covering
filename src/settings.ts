import pkg from '../package.json';

/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = 'knx-window-covering';

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = 'homebridge-' + PLATFORM_NAME;
export const PLUGIN_DISPLAY_NAME = pkg.displayName;
export const PLUGIN_VERSION = pkg.version;