// ---------------------------------------------------------------------------
// Command consts (not TypeScript enums — used as string literal namespaces)
// ---------------------------------------------------------------------------

export const FeederRobotCommand = {
  GIVE_SNACK: "giveSnack",
  SET_AUTO_NIGHT_MODE: "setAutoNightMode",
  SET_GRAVITY_MODE: "setGravityMode",
  SET_PANEL_LOCKOUT: "setPanelLockout",
} as const;

export const LitterBoxCommand = {
  ENDPOINT: "dispatch-commands",
  PREFIX: "<",
  CLEAN: "C",
  DEFAULT_SETTINGS: "D",
  LOCK_OFF: "L0",
  LOCK_ON: "L1",
  NIGHT_LIGHT_OFF: "N0",
  NIGHT_LIGHT_ON: "N1",
  POWER_OFF: "P0",
  POWER_ON: "P1",
  SLEEP_MODE_OFF: "S0",
  SLEEP_MODE_ON: "S1",
  WAIT_TIME: "W",
} as const;

export const LitterRobot4Command = {
  CLEAN_CYCLE: "cleanCycle",
  KEY_PAD_LOCK_OUT_OFF: "keyPadLockOutOff",
  KEY_PAD_LOCK_OUT_ON: "keyPadLockOutOn",
  NIGHT_LIGHT_MODE_AUTO: "nightLightModeAuto",
  NIGHT_LIGHT_MODE_OFF: "nightLightModeOff",
  NIGHT_LIGHT_MODE_ON: "nightLightModeOn",
  PANEL_BRIGHTNESS_LOW: "panelBrightnessLow",
  PANEL_BRIGHTNESS_MEDIUM: "panelBrightnessMed",
  PANEL_BRIGHTNESS_HIGH: "panelBrightnessHigh",
  POWER_OFF: "powerOff",
  POWER_ON: "powerOn",
  REQUEST_STATE: "requestState",
  SET_CLUMP_TIME: "setClumpTime",
  SET_NIGHT_LIGHT_VALUE: "setNightLightValue",
  SHORT_RESET_PRESS: "shortResetPress",
} as const;

export const LitterRobot5Command = {
  // POST /robots/{serial}/commands — operational
  CLEAN_CYCLE: "CLEAN_CYCLE",
  POWER_ON: "POWER_ON",
  POWER_OFF: "POWER_OFF",
  REMOTE_RESET: "REMOTE_RESET",
  FACTORY_RESET: "FACTORY_RESET",
  RESET_WASTE_LEVEL: "RESET_WASTE_LEVEL",
  CHANGE_FILTER: "CHANGE_FILTER",
  ONBOARD_PTAG_ON: "ONBOARD_PTAG_ON",
  ONBOARD_PTAG_OFF: "ONBOARD_PTAG_OFF",
  PRIVACY_MODE_ON: "PRIVACY_MODE_ON",
  PRIVACY_MODE_OFF: "PRIVACY_MODE_OFF",
  // PATCH /robots/{serial} — settings keys
  CYCLE_DELAY: "cycleDelay",
  KEYPAD_LOCKED: "isKeypadLocked",
  LITTER_ROBOT_SETTINGS: "litterRobotSettings",
  NIGHT_LIGHT_SETTINGS: "nightLightSettings",
  PANEL_SETTINGS: "panelSettings",
  SOUND_SETTINGS: "soundSettings",
} as const;

// ---------------------------------------------------------------------------
// LitterBoxStatus
// ---------------------------------------------------------------------------

export interface LitterBoxStatusEntry {
  readonly value: string | null;
  readonly text: string | null;
  readonly minimumCyclesLeft: number;
}

const makeStatus = (
  value: string | null,
  text: string | null = null,
  minimumCyclesLeft = 3,
): LitterBoxStatusEntry => ({ value, text, minimumCyclesLeft });

export const LitterBoxStatus = {
  BONNET_REMOVED: makeStatus("BR", "Bonnet Removed"),
  CLEAN_CYCLE_COMPLETE: makeStatus("CCC", "Clean Cycle Complete"),
  CLEAN_CYCLE: makeStatus("CCP", "Clean Cycle In Progress"),
  CAT_DETECTED: makeStatus("CD", "Cat Detected"),
  CAT_SENSOR_FAULT: makeStatus("CSF", "Cat Sensor Fault"),
  CAT_SENSOR_INTERRUPTED: makeStatus("CSI", "Cat Sensor Interrupted"),
  CAT_SENSOR_TIMING: makeStatus("CST", "Cat Sensor Timing"),
  DRAWER_FULL_1: makeStatus("DF1", "Drawer Almost Full - 2 Cycles Left", 2),
  DRAWER_FULL_2: makeStatus("DF2", "Drawer Almost Full - 1 Cycle Left", 1),
  DRAWER_FULL: makeStatus("DFS", "Drawer Full", 0),
  DUMP_HOME_POSITION_FAULT: makeStatus("DHF", "Dump + Home Position Fault"),
  DUMP_POSITION_FAULT: makeStatus("DPF", "Dump Position Fault"),
  EMPTY_CYCLE: makeStatus("EC", "Empty Cycle"),
  HOME_POSITION_FAULT: makeStatus("HPF", "Home Position Fault"),
  OFF: makeStatus("OFF", "Off"),
  OFFLINE: makeStatus("OFFLINE", "Offline"),
  OVER_TORQUE_FAULT: makeStatus("OTF", "Over Torque Fault"),
  PAUSED: makeStatus("P", "Clean Cycle Paused"),
  PINCH_DETECT: makeStatus("PD", "Pinch Detect"),
  POWER_DOWN: makeStatus("PWRD", "Powering Down"),
  POWER_UP: makeStatus("PWRU", "Powering Up"),
  READY: makeStatus("RDY", "Ready"),
  STARTUP_CAT_SENSOR_FAULT: makeStatus("SCF", "Cat Sensor Fault At Startup"),
  STARTUP_DRAWER_FULL: makeStatus("SDF", "Drawer Full At Startup", 0),
  STARTUP_PINCH_DETECT: makeStatus("SPF", "Pinch Detect At Startup"),
  UNKNOWN: makeStatus(null, "Unknown"),
} as const satisfies Record<string, LitterBoxStatusEntry>;

export type LitterBoxStatusKey = keyof typeof LitterBoxStatus;

const _statusByValue = new Map<string, LitterBoxStatusEntry>(
  Object.values(LitterBoxStatus)
    .filter((s) => s.value !== null)
    .map((s) => [s.value as string, s]),
);

/** Look up a LitterBoxStatus entry by its code string. Returns UNKNOWN for unrecognised codes. */
export function lbStatusFromValue(value: string | null | undefined): LitterBoxStatusEntry {
  if (value == null) return LitterBoxStatus.UNKNOWN;
  return _statusByValue.get(value) ?? LitterBoxStatus.UNKNOWN;
}

export function getDrawerFullStatuses(
  completelyFull = true,
  almostFull = true,
  codesOnly = false,
): Array<LitterBoxStatusEntry | string> {
  const statuses: LitterBoxStatusEntry[] = [
    ...(completelyFull ? [LitterBoxStatus.DRAWER_FULL, LitterBoxStatus.STARTUP_DRAWER_FULL] : []),
    ...(almostFull ? [LitterBoxStatus.DRAWER_FULL_1, LitterBoxStatus.DRAWER_FULL_2] : []),
  ];
  return codesOnly ? statuses.map((s) => s.value as string) : statuses;
}

// ---------------------------------------------------------------------------
// BrightnessLevel
// ---------------------------------------------------------------------------

export enum BrightnessLevel {
  LOW = 25,
  MEDIUM = 50,
  HIGH = 100,
}

// ---------------------------------------------------------------------------
// GlobeMotorFaultStatus
// ---------------------------------------------------------------------------

export enum GlobeMotorFaultStatus {
  NONE = "NONE",
  FAULT_CLEAR = "FAULT_CLEAR",
  FAULT_TIMEOUT = "FAULT_TIMEOUT",
  FAULT_DISCONNECT = "FAULT_DISCONNECT",
  FAULT_UNDERVOLTAGE = "FAULT_UNDERVOLTAGE",
  FAULT_OVERTORQUE_AMP = "FAULT_OVERTORQUE_AMP",
  FAULT_OVERTORQUE_SLOPE = "FAULT_OVERTORQUE_SLOPE",
  FAULT_PINCH = "FAULT_PINCH",
  FAULT_ALL_SENSORS = "FAULT_ALL_SENSORS",
  FAULT_UNKNOWN = "FAULT_UNKNOWN",
}

const _globeMotorValues = new Set(Object.values(GlobeMotorFaultStatus));

/** Convert a raw string (including PascalCase from LR5) to GlobeMotorFaultStatus. */
export function globeMotorFaultFromRaw(raw: string | null | undefined): GlobeMotorFaultStatus {
  if (raw == null || raw.trim() === "") return GlobeMotorFaultStatus.NONE;

  let value = raw.trim();

  // LR4 format already matches exactly
  if (_globeMotorValues.has(value as GlobeMotorFaultStatus)) {
    return value as GlobeMotorFaultStatus;
  }

  // Convert PascalCase → SNAKE_CASE
  value = value.replace(/(?<!^)(?=[A-Z])/g, "_").toUpperCase();

  // Strip common LR5 prefixes
  value = value.replace(/^MTR_/, "").replace(/^MOTOR_/, "");

  // Ensure FAULT_ prefix
  if (!value.startsWith("FAULT_") && value !== "NONE") {
    value = `FAULT_${value}`;
  }

  if (_globeMotorValues.has(value as GlobeMotorFaultStatus)) {
    return value as GlobeMotorFaultStatus;
  }

  return GlobeMotorFaultStatus.FAULT_UNKNOWN;
}

// ---------------------------------------------------------------------------
// HopperStatus
// ---------------------------------------------------------------------------

export enum HopperStatus {
  ENABLED = "ENABLED",
  DISABLED = "DISABLED",
  MOTOR_FAULT_SHORT = "MOTOR_FAULT_SHORT",
  MOTOR_OT_AMPS = "MOTOR_OT_AMPS",
  MOTOR_DISCONNECTED = "MOTOR_DISCONNECTED",
  EMPTY = "EMPTY",
}

// ---------------------------------------------------------------------------
// LitterLevelState
// ---------------------------------------------------------------------------

export enum LitterLevelState {
  OVERFILL = "OVERFILL",
  OPTIMAL = "OPTIMAL",
  REFILL = "REFILL",
  LOW = "LOW",
  EMPTY = "EMPTY",
}

// ---------------------------------------------------------------------------
// NightLightMode
// ---------------------------------------------------------------------------

export enum NightLightMode {
  OFF = "OFF",
  ON = "ON",
  AUTO = "AUTO",
}
