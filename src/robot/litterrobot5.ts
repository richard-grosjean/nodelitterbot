import type { Account } from "../account.js";
import { Activity, Insight } from "../activity.js";
import {
  BrightnessLevel,
  GlobeMotorFaultStatus,
  globeMotorFaultFromRaw,
  HopperStatus,
  type LitterBoxStatusEntry,
  LitterBoxStatus,
  LitterLevelState,
  LitterRobot5Command,
  NightLightMode,
} from "../enums.js";
import { InvalidCommandException, LitterRobotException } from "../exceptions.js";
import { SleepSchedule } from "../sleepSchedule.js";
import {
  calculateLitterLevel,
  toEnum,
  toTimestamp,
  urljoin,
  utcnow,
} from "../utils.js";
import { PollingTransport } from "../transport.js";
import { LitterRobot } from "./litterrobot.js";

export const LR5_ENDPOINT = "https://ub.prod.iothings.site";

const SLEEP_SCHEDULES = "sleepSchedules";
const DEFAULT_POLLING_INTERVAL = 30;
const LITTER_LEVEL_EMPTY = 500;

const MODEL_TYPE_MAP: Record<string, string> = {
  LR5: "Litter-Robot 5",
  LR5_PRO: "Litter-Robot 5 Pro",
};

// ---------------------------------------------------------------------------
// Status maps
// ---------------------------------------------------------------------------

const LR5_STATE_MAP: Record<string, LitterBoxStatusEntry> = {
  StRobotBonnet: LitterBoxStatus.BONNET_REMOVED,
  StRobotCatDetect: LitterBoxStatus.CAT_DETECTED,
  StRobotCatDetectDelay: LitterBoxStatus.CAT_SENSOR_TIMING,
  StRobotClean: LitterBoxStatus.CLEAN_CYCLE,
  StRobotEmpty: LitterBoxStatus.EMPTY_CYCLE,
  StRobotFindDump: LitterBoxStatus.CLEAN_CYCLE,
  StRobotIdle: LitterBoxStatus.READY,
  StRobotPowerDown: LitterBoxStatus.POWER_DOWN,
  StRobotPowerOff: LitterBoxStatus.OFF,
  StRobotPowerUp: LitterBoxStatus.POWER_UP,
};

const LR5_STATUS_MAP: Record<string, LitterBoxStatusEntry> = {
  ROBOT_BONNET: LitterBoxStatus.BONNET_REMOVED,
  ROBOT_CAT_DETECT: LitterBoxStatus.CAT_DETECTED,
  ROBOT_CAT_DETECT_DELAY: LitterBoxStatus.CAT_SENSOR_TIMING,
  ROBOT_CLEAN: LitterBoxStatus.CLEAN_CYCLE,
  ROBOT_EMPTY: LitterBoxStatus.EMPTY_CYCLE,
  ROBOT_FIND_DUMP: LitterBoxStatus.CLEAN_CYCLE,
  ROBOT_IDLE: LitterBoxStatus.READY,
  ROBOT_POWER_DOWN: LitterBoxStatus.POWER_DOWN,
  ROBOT_POWER_OFF: LitterBoxStatus.OFF,
  ROBOT_POWER_UP: LitterBoxStatus.POWER_UP,
};

const DISPLAY_CODE_STATUS_MAP: Record<string, LitterBoxStatusEntry> = {
  DcCatDetect: LitterBoxStatus.CAT_DETECTED,
  DcDfiFull: LitterBoxStatus.DRAWER_FULL,
  DcModeCycle: LitterBoxStatus.CLEAN_CYCLE,
  DcModeIdle: LitterBoxStatus.READY,
  DcxLampTest: LitterBoxStatus.POWER_UP,
  DcxSuspend: LitterBoxStatus.POWER_DOWN,
  DC_CAT_DETECT: LitterBoxStatus.CAT_DETECTED,
};

const STATUS_INDICATOR_MAP: Record<string, LitterBoxStatusEntry> = {
  READY: LitterBoxStatus.READY,
  DRAWER_FULL: LitterBoxStatus.DRAWER_FULL,
  CYCLING: LitterBoxStatus.CLEAN_CYCLE,
  LITTER_LOW: LitterBoxStatus.READY,
  CAT_DETECTED: LitterBoxStatus.CAT_DETECTED,
  BONNET_REMOVED: LitterBoxStatus.BONNET_REMOVED,
  OFF: LitterBoxStatus.OFF,
  OFFLINE: LitterBoxStatus.OFFLINE,
};

const CYCLE_STATE_STATUS_MAP: Record<string, LitterBoxStatusEntry> = {
  StCatDetect: LitterBoxStatus.CAT_SENSOR_INTERRUPTED,
  StPause: LitterBoxStatus.PAUSED,
  CYCLE_STATE_CAT_DETECT: LitterBoxStatus.CAT_SENSOR_INTERRUPTED,
  CYCLE_STATE_PAUSE: LitterBoxStatus.PAUSED,
};

// Operational commands that go through POST /commands
const OPERATIONAL_COMMANDS: Set<string> = new Set([
  LitterRobot5Command.CLEAN_CYCLE,
  LitterRobot5Command.POWER_ON,
  LitterRobot5Command.POWER_OFF,
  LitterRobot5Command.REMOTE_RESET,
  LitterRobot5Command.FACTORY_RESET,
  LitterRobot5Command.RESET_WASTE_LEVEL,
  LitterRobot5Command.CHANGE_FILTER,
  LitterRobot5Command.ONBOARD_PTAG_ON,
  LitterRobot5Command.ONBOARD_PTAG_OFF,
  LitterRobot5Command.PRIVACY_MODE_ON,
  LitterRobot5Command.PRIVACY_MODE_OFF,
]);

// ---------------------------------------------------------------------------
// LitterRobot5
// ---------------------------------------------------------------------------

export class LitterRobot5 extends LitterRobot {
  protected override readonly _dataId = "serial";
  protected override readonly _dataName = "name";
  protected override readonly _dataSerial = "serial";
  protected override readonly _dataSetupDate = "setupDateTime";
  protected override _dataCycleCapacity = "DFINumberOfCycles";
  protected override _dataCycleCount = "odometerCleanCycles";
  protected override _dataDrawerFullCycles = "DFIFullCounter";
  protected override _dataPowerStatus = "powerStatus";

  static override readonly VALID_WAIT_TIMES = [3, 7, 15, 25, 30];

  protected override readonly _commandClean = LitterRobot5Command.CLEAN_CYCLE;
  protected override readonly _commandPowerOff = LitterRobot5Command.POWER_OFF;
  protected override readonly _commandPowerOn = LitterRobot5Command.POWER_ON;

  protected override readonly _path = LR5_ENDPOINT;

  private _litterLevel = LITTER_LEVEL_EMPTY;
  private _litterLevelExp: Date | null = null;
  private _previousSleepData: Array<Record<string, unknown>> | null = null;

  constructor(data: Record<string, unknown>, account: Account) {
    super(data, account);
    this._assertSerial();
  }

  get model(): string {
    const modelType = (this._data["type"] as string | undefined) ?? "Unknown";
    return MODEL_TYPE_MAP[modelType] ?? modelType;
  }

  get isPro(): boolean {
    return this._data["type"] === "LR5_PRO";
  }

  // ---------------------------------------------------------------------------
  // Helper for nested data dicts
  // ---------------------------------------------------------------------------

  private _getDataDict(key: string): Record<string, unknown> {
    const v = this._data[key];
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  }

  private get _state(): Record<string, unknown> { return this._getDataDict("state"); }
  private get _litterRobotSettings(): Record<string, unknown> { return this._getDataDict("litterRobotSettings"); }
  private get _nightLightSettings(): Record<string, unknown> { return this._getDataDict("nightLightSettings"); }
  private get _panelSettings(): Record<string, unknown> { return this._getDataDict("panelSettings"); }
  private get _soundSettings(): Record<string, unknown> { return this._getDataDict("soundSettings"); }

  // ---------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------

  override get setupDate(): Date | null {
    return toTimestamp(
      (this._state["setupDateTime"] ?? this._data["setupDateTime"]) as string | undefined,
    );
  }

  override get lastSeen(): Date | null {
    return toTimestamp(
      (this._state["lastSeen"] ?? this._data["lastSeen"]) as string | undefined,
    );
  }

  override get timezone(): string | null {
    return (this._data["timezone"] as string | undefined) ?? null;
  }

  get cleanCycleWaitTimeMinutes(): number {
    return Number(this._litterRobotSettings["cycleDelay"] ?? 7);
  }

  get cameraMetadata(): Record<string, string> | null {
    const cam = this._data["cameraMetadata"];
    return typeof cam === "object" && cam !== null ? cam as Record<string, string> : null;
  }

  get catDetect(): string {
    return String(this._state["catDetect"] ?? "");
  }

  override get cycleCount(): number {
    return Number(this._state[this._dataCycleCount] ?? 0);
  }

  get cycleType(): string {
    return String(this._state["cycleType"] ?? "");
  }

  get firmware(): string {
    const fw = (this._state["firmwareVersions"] as Record<string, unknown> | undefined) ?? {};
    type FwEntry = { value?: string } | string | null | undefined;
    const resolve = (v: FwEntry, fallback?: string): string | null => {
      if (typeof v === "object" && v !== null) return v.value ?? null;
      return typeof v === "string" ? v : (fallback ? (this._state[fallback] as string | undefined) ?? null : null);
    };
    const parts: string[] = [];
    const wifi = resolve(fw["wifiVersion"] as FwEntry, "espFirmwareVersion");
    const mcu = resolve(fw["mcuVersion"] as FwEntry, "stmFirmwareVersion");
    if (wifi) parts.push(`ESP: ${wifi}`);
    if (mcu) parts.push(`MCU: ${mcu}`);
    for (const [key, label] of [["cameraVersion", "CAM"], ["edgeVersion", "EDGE"], ["aiVersion", "AI"]] as const) {
      const ver = resolve(fw[key] as FwEntry);
      if (ver) parts.push(`${label}: ${ver}`);
    }
    return parts.join(" / ");
  }

  get firmwareUpdateStatus(): string {
    return String(this._state["espUpdateStatus"] ?? this._state["firmwareUpdateStatus"] ?? "UNKNOWN");
  }

  get firmwareUpdateTriggered(): boolean {
    return this._data["isFirmwareUpdateTriggered"] === true;
  }

  get globeMotorFaultStatus(): GlobeMotorFaultStatus {
    return globeMotorFaultFromRaw(this._state["globeMotorFaultStatus"] as string | undefined);
  }

  get globeMotorRetractFaultStatus(): GlobeMotorFaultStatus {
    return globeMotorFaultFromRaw(this._state["globeMotorRetractFaultStatus"] as string | undefined);
  }

  get hopperFault(): string | undefined {
    return this._state["hopperFault"] as string | undefined;
  }

  get hopperStatus(): HopperStatus | undefined {
    return toEnum(HopperStatus, this._state["hopperStatus"]);
  }

  get isBonnetRemoved(): boolean {
    return this._state["isBonnetRemoved"] === true;
  }

  get isDrawerFullIndicatorTriggered(): boolean {
    return Number(this._state["dfiFullCounter"] ?? 0) > 0;
  }

  get isDrawerRemoved(): boolean {
    return this._state["isDrawerRemoved"] === true;
  }

  get isFirmwareUpdating(): boolean {
    return this._state["isFirmwareUpdating"] === true;
  }

  get isGasSensorFaultDetected(): boolean {
    return this._state["isGasSensorFaultDetected"] === true;
  }

  get isHopperRemoved(): boolean {
    return this._state["isHopperInstalled"] === false;
  }

  get isLaserDirty(): boolean {
    return this._state["isLaserDirty"] === true;
  }

  override get isOnline(): boolean {
    return this._state["isOnline"] === true;
  }

  override get isOnboarded(): boolean {
    return this._data["isOnboarded"] === true;
  }

  get isNightLightOn(): boolean {
    return this._state["isNightLightOn"] === true;
  }

  override get isSleeping(): boolean {
    return this._state["isSleeping"] === true;
  }

  get isSmartWeightEnabled(): boolean {
    return this._litterRobotSettings["isSmartWeightEnabled"] === true;
  }

  get isUsbFaultDetected(): boolean {
    return this._state["isUsbFaultDetected"] === true;
  }

  override get isWasteDrawerFull(): boolean {
    return this._state["isDrawerFull"] === true;
  }

  get litterLevel(): number {
    return Number(this._state["litterLevelPercent"] ?? 0);
  }

  get litterLevelCalculated(): number {
    const cycleInfo = String(this._state["cycleType"] ?? this._state["robotCycleState"] ?? "");
    const isCleaning = cycleInfo.toUpperCase().includes("CLEAN");
    const newLevel = Number(this._state["globeLitterLevel"] ?? this._state["litterLevel"] ?? LITTER_LEVEL_EMPTY);
    const [level, exp, percent] = calculateLitterLevel(isCleaning, newLevel, this._litterLevel, this._litterLevelExp);
    this._litterLevel = level;
    this._litterLevelExp = exp;
    return percent;
  }

  get litterLevelState(): LitterLevelState | undefined {
    return toEnum(LitterLevelState, this._state["globeLitterLevelIndicator"]);
  }

  get lastResetOdometerCleanCycles(): number {
    return Number(this._state["lastResetOdometerCleanCycles"] ?? 0);
  }

  get nextFilterReplacementDate(): Date | null {
    return toTimestamp(this._data["nextFilterReplacementDate"] as string | undefined);
  }

  get nightLightBrightness(): number {
    return Number(this._nightLightSettings["brightness"] ?? 0);
  }

  get nightLightColor(): string | undefined {
    return this._nightLightSettings["color"] as string | undefined;
  }

  get nightLightLevel(): BrightnessLevel | undefined {
    return toEnum(BrightnessLevel, this._nightLightSettings["brightness"], false);
  }

  get nightLightMode(): NightLightMode | undefined {
    return toEnum(NightLightMode, this._nightLightSettings["mode"]);
  }

  override get nightLightModeEnabled(): boolean {
    const mode = this._nightLightSettings["mode"];
    return mode ? String(mode).toLowerCase() !== "off" : false;
  }

  get panelBrightness(): BrightnessLevel | undefined {
    const intensity = this._panelSettings["displayIntensity"];
    if (typeof intensity === "string") {
      const map: Record<string, BrightnessLevel> = {
        low: BrightnessLevel.LOW,
        medium: BrightnessLevel.MEDIUM,
        high: BrightnessLevel.HIGH,
      };
      const found = map[intensity.toLowerCase()];
      if (found !== undefined) return found;
    }
    return toEnum(BrightnessLevel, this._panelSettings["brightness"], false);
  }

  override get panelLockEnabled(): boolean {
    return Boolean(this._panelSettings[LitterRobot5Command.KEYPAD_LOCKED] ?? false);
  }

  get petWeight(): number {
    return (Number(this._state["weightSensor"] ?? 0)) / 100;
  }

  override get powerStatus(): string {
    return String(this._state[this._dataPowerStatus] ?? "On");
  }

  get privacyMode(): string {
    return String(this._state["privacyMode"] ?? "Normal");
  }

  get scoopsSavedCount(): number {
    return Number(this._state["scoopsSaved"] ?? 0);
  }

  get stmUpdateStatus(): string {
    return String(this._state["stmUpdateStatus"] ?? "UNKNOWN");
  }

  get soundVolume(): number {
    return Number(this._soundSettings["volume"] ?? 0);
  }

  get cameraAudioEnabled(): boolean {
    return this._soundSettings["cameraAudioEnabled"] === true;
  }

  get wifiRssi(): number {
    return Number(this._state["wifiRssi"] ?? 0);
  }

  get odometerEmptyCycles(): number {
    return Number(this._state["odometerEmptyCycles"] ?? 0);
  }

  get odometerFilterCycles(): number {
    return Number(this._state["odometerFilterCycles"] ?? 0);
  }

  get odometerPowerCycles(): number {
    return Number(this._state["odometerPowerCycles"] ?? 0);
  }

  get optimalLitterLevel(): number {
    return Number(this._state["optimalLitterLevel"] ?? 0);
  }

  get pinchStatus(): string {
    return String(this._state["pinchStatus"] ?? "");
  }

  get status(): LitterBoxStatusEntry {
    if (!this.isOnline) return LitterBoxStatus.OFFLINE;

    // 1. Cycle state
    const cycleState = (this._state["cycleState"] ?? this._state["robotCycleState"]) as string | undefined;
    if (cycleState && CYCLE_STATE_STATUS_MAP[cycleState]) return CYCLE_STATE_STATUS_MAP[cycleState]!;

    // 2. Robot state
    const robotState = this._state["state"] as string | undefined;
    if (robotState && LR5_STATE_MAP[robotState]) {
      const mapped = LR5_STATE_MAP[robotState]!;
      if (mapped === LitterBoxStatus.READY && this.isWasteDrawerFull) return LitterBoxStatus.DRAWER_FULL;
      return mapped;
    }

    // 3. Display code
    const displayCode = this._state["displayCode"] as string | undefined;
    if (displayCode && DISPLAY_CODE_STATUS_MAP[displayCode]) {
      const mapped = DISPLAY_CODE_STATUS_MAP[displayCode]!;
      if (mapped === LitterBoxStatus.READY && this.isWasteDrawerFull) return LitterBoxStatus.DRAWER_FULL;
      return mapped;
    }

    // 4. Status indicator
    const indicator = this._state["statusIndicator"];
    if (typeof indicator === "object" && indicator !== null) {
      const indicatorType = (indicator as Record<string, unknown>)["type"] as string | undefined;
      if (indicatorType && STATUS_INDICATOR_MAP[indicatorType]) {
        const mapped = STATUS_INDICATOR_MAP[indicatorType]!;
        if (mapped === LitterBoxStatus.READY && this.isWasteDrawerFull) return LitterBoxStatus.DRAWER_FULL;
        return mapped;
      }
    }

    // 5. Legacy string
    const rawStatus = (this._state["status"] ?? this._state["robotStatus"]) as string | undefined;
    if (typeof rawStatus === "string") {
      if (LR5_STATUS_MAP[rawStatus]) {
        const mapped = LR5_STATUS_MAP[rawStatus]!;
        if (mapped === LitterBoxStatus.READY && this.isWasteDrawerFull) return LitterBoxStatus.DRAWER_FULL;
        return mapped;
      }
      const upper = rawStatus.trim().toUpperCase();
      let s: LitterBoxStatusEntry = LitterBoxStatus.UNKNOWN;
      if (upper === "READY" || upper === "IDLE") s = LitterBoxStatus.READY;
      else if (upper.includes("CLEAN") || upper.includes("DUMP")) s = LitterBoxStatus.CLEAN_CYCLE;
      else if (upper.includes("CAT")) s = LitterBoxStatus.CAT_DETECTED;
      else if (upper.includes("POWER") && upper.includes("UP")) s = LitterBoxStatus.POWER_UP;
      else if (upper.includes("POWER")) s = LitterBoxStatus.POWER_DOWN;
      else if (upper.includes("OFF")) s = LitterBoxStatus.OFF;
      if (s !== LitterBoxStatus.UNKNOWN) {
        if (s === LitterBoxStatus.READY && this.isWasteDrawerFull) return LitterBoxStatus.DRAWER_FULL;
        return s;
      }
    }

    return LitterBoxStatus.UNKNOWN;
  }

  get statusCode(): string | null {
    if (this.status !== LitterBoxStatus.UNKNOWN) return this.status.value;
    return (this._state["status"] as string | undefined) ?? null;
  }

  get wasteDrawerLevel(): number {
    return Number(this._state["dfiLevelPercent"] ?? 0);
  }

  get extendedScaleActivity(): boolean {
    return this._state["extendedScaleActivity"] === true;
  }

  // ---------------------------------------------------------------------------
  // Sleep info
  // ---------------------------------------------------------------------------

  protected _parseSleepInfo(): void {
    const sleepData = (this._data[SLEEP_SCHEDULES] as Array<Record<string, unknown>> | undefined) ?? [];
    if (JSON.stringify(sleepData) === JSON.stringify(this._previousSleepData)) return;
    this._previousSleepData = sleepData;
    this._sleepSchedule = SleepSchedule.parse(sleepData);
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  protected async _dispatchCommand(command: string, value?: unknown): Promise<boolean> {
    if (OPERATIONAL_COMMANDS.has(command)) {
      return this._sendCommand(command);
    }

    try {
      const body: Record<string, unknown> = { [command]: value ?? null };
      await this._patch(`robots/${this.serial}`, { json: body });
      // Optimistic local update
      if (value !== undefined) {
        const existing = this._data[command];
        const merged =
          typeof existing === "object" && existing !== null && typeof value === "object" && value !== null
            ? { ...existing as Record<string, unknown>, ...value as Record<string, unknown> }
            : value;
        this._updateData({ [command]: merged }, true);
      }
      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  private async _sendCommand(command: string): Promise<boolean> {
    try {
      await this._account.session.request("POST", `${LR5_ENDPOINT}/robots/${this.serial}/commands`, {
        json: { type: command },
      });
      return true;
    } catch (err) {
      console.error(`Command ${command} failed:`, err);
      return false;
    }
  }

  override async refresh(): Promise<void> {
    const data = await this._get(`robots/${this.serial}`);
    if (typeof data === "object" && data !== null) {
      this._updateData(data as Record<string, unknown>);
    }
  }

  async reset(): Promise<boolean> {
    return this._dispatchCommand(LitterRobot5Command.REMOTE_RESET);
  }

  async resetWasteDrawer(): Promise<boolean> {
    return this._dispatchCommand(LitterRobot5Command.RESET_WASTE_LEVEL);
  }

  async changeFilter(): Promise<boolean> {
    return this._dispatchCommand(LitterRobot5Command.CHANGE_FILTER);
  }

  override async setName(name: string): Promise<boolean> {
    await this._patch(`robots/${this.serial}`, { json: { name } });
    this._updateData({ name }, true);
    return this.name === name;
  }

  async setNightLightSettings(opts: { mode?: NightLightMode; brightness?: number; color?: string }): Promise<boolean> {
    const value: Record<string, unknown> = {};
    if (opts.mode !== undefined) value["mode"] = opts.mode;
    if (opts.brightness !== undefined) {
      if (opts.brightness < 0 || opts.brightness > 100) {
        throw new InvalidCommandException(`Invalid brightness: ${opts.brightness}. Must be 0–100.`);
      }
      value["brightness"] = opts.brightness;
    }
    if (opts.color !== undefined) value["color"] = opts.color;
    if (Object.keys(value).length === 0) throw new InvalidCommandException("At least one option must be provided.");
    return this._dispatchCommand(LitterRobot5Command.NIGHT_LIGHT_SETTINGS, value);
  }

  override async setNightLight(value: boolean): Promise<boolean> {
    return this.setNightLightSettings({ mode: value ? NightLightMode.ON : NightLightMode.OFF });
  }

  async setNightLightBrightness(brightness: number): Promise<boolean> {
    return this.setNightLightSettings({ brightness });
  }

  async setNightLightMode(mode: NightLightMode): Promise<boolean> {
    return this.setNightLightSettings({ mode });
  }

  async setPanelBrightness(brightness: BrightnessLevel): Promise<boolean> {
    const map: Record<number, string> = {
      [BrightnessLevel.LOW]: "Low",
      [BrightnessLevel.MEDIUM]: "Medium",
      [BrightnessLevel.HIGH]: "High",
    };
    if (!map[brightness]) throw new InvalidCommandException(`Invalid brightness: ${brightness}`);
    return this._dispatchCommand(LitterRobot5Command.PANEL_SETTINGS, { displayIntensity: map[brightness] });
  }

  override async setPanelLockout(value: boolean): Promise<boolean> {
    const ok = await this._dispatchCommand(
      LitterRobot5Command.PANEL_SETTINGS,
      { [LitterRobot5Command.KEYPAD_LOCKED]: value },
    );
    if (!ok) return false;
    return this.panelLockEnabled === value;
  }

  async setPrivacyMode(value: boolean): Promise<boolean> {
    return this._dispatchCommand(
      value ? LitterRobot5Command.PRIVACY_MODE_ON : LitterRobot5Command.PRIVACY_MODE_OFF,
    );
  }

  override async setSleepMode(
    value: boolean,
    sleepTime?: Date | null,
    opts?: { wakeTime?: number; dayOfWeek?: number },
  ): Promise<boolean> {
    const schedules: Array<Record<string, unknown>> = JSON.parse(
      JSON.stringify(this._data[SLEEP_SCHEDULES] ?? []),
    ) as Array<Record<string, unknown>>;

    if (schedules.length === 0) {
      for (let d = 0; d < 7; d++) {
        schedules.push({ dayOfWeek: d, isEnabled: false, sleepTime: 0, wakeTime: 0 });
      }
    }

    for (const schedule of schedules) {
      if (opts?.dayOfWeek !== undefined && schedule["dayOfWeek"] !== opts.dayOfWeek) continue;
      schedule["isEnabled"] = value;
      if (sleepTime !== null && sleepTime !== undefined) {
        const sleepMinutes =
          sleepTime instanceof Date
            ? sleepTime.getHours() * 60 + sleepTime.getMinutes()
            : sleepTime;
        schedule["sleepTime"] = sleepMinutes;
      }
      if (opts?.wakeTime !== undefined) schedule["wakeTime"] = opts.wakeTime;
    }

    try {
      await this._patch(`robots/${this.serial}`, { json: { [SLEEP_SCHEDULES]: schedules } });
      this._updateData({ [SLEEP_SCHEDULES]: schedules }, true);
      return true;
    } catch (err) {
      console.error("Failed to set sleep mode:", err);
      return false;
    }
  }

  async setVolume(volume: number): Promise<boolean> {
    if (volume < 0 || volume > 100) throw new InvalidCommandException(`Invalid volume ${volume}: must be 0-100.`);
    return this._dispatchCommand(LitterRobot5Command.SOUND_SETTINGS, { volume });
  }

  async setCameraAudio(value: boolean): Promise<boolean> {
    return this._dispatchCommand(LitterRobot5Command.SOUND_SETTINGS, { cameraAudioEnabled: value });
  }

  override async setWaitTime(waitTime: number): Promise<boolean> {
    if (!LitterRobot5.VALID_WAIT_TIMES.includes(waitTime)) {
      throw new InvalidCommandException(
        `Invalid wait time. Must be one of: ${LitterRobot5.VALID_WAIT_TIMES}, received ${waitTime}`,
      );
    }
    const ok = await this._dispatchCommand(
      LitterRobot5Command.LITTER_ROBOT_SETTINGS,
      { [LitterRobot5Command.CYCLE_DELAY]: waitTime },
    );
    if (!ok) return false;
    return this.cleanCycleWaitTimeMinutes === waitTime;
  }

  // ---------------------------------------------------------------------------
  // Activity / Insight
  // ---------------------------------------------------------------------------

  async getActivityHistory(limit = 100): Promise<Activity[]> {
    if (limit < 1) throw new InvalidCommandException(`Invalid limit: ${limit}`);
    const activities = await this.getActivities({ limit });
    return activities.flatMap((a) => {
      const ts = toTimestamp(a["timestamp"] as string | undefined);
      if (!ts) return [];
      return [new Activity(ts, String(a["type"] ?? ""))];
    });
  }

  async getActivities(opts?: {
    limit?: number;
    offset?: number;
    activityType?: string;
  }): Promise<Array<Record<string, unknown>>> {
    const params: Record<string, string> = {};
    if (opts?.limit !== undefined) params["limit"] = String(opts.limit);
    if (opts?.offset !== undefined) params["offset"] = String(opts.offset);
    if (opts?.activityType) params["type"] = opts.activityType;
    const data = await this._account.session.request(
      "GET",
      `${LR5_ENDPOINT}/robots/${this.serial}/activities`,
      { params },
    );
    return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  }

  async getInsight(_days?: number, _timezoneOffset?: number | null): Promise<Insight> {
    throw new LitterRobotException(
      "Insight data is not available via the LR5 REST API. Use getActivities() instead.",
    );
  }

  async reassignPetVisit(
    eventId: string,
    opts?: { fromPetId?: string; toPetId?: string },
  ): Promise<Record<string, unknown> | null> {
    if (!eventId) throw new InvalidCommandException("eventId must be provided");
    if (!opts?.fromPetId && !opts?.toPetId) {
      throw new InvalidCommandException("At least one of fromPetId or toPetId must be provided");
    }
    const body: Record<string, string> = { eventId };
    if (opts.fromPetId) body["fromPetId"] = opts.fromPetId;
    if (opts.toPetId) body["toPetId"] = opts.toPetId;
    try {
      const data = await this._account.session.request(
        "PATCH",
        `${LR5_ENDPOINT}/robots/${this.serial}/activities`,
        { json: body },
      );
      return typeof data === "object" && data !== null ? data as Record<string, unknown> : null;
    } catch (err) {
      console.error("Reassign pet visit failed:", err);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Transport — polling only
  // ---------------------------------------------------------------------------

  protected override _buildTransport(): PollingTransport {
    return new PollingTransport(DEFAULT_POLLING_INTERVAL);
  }

  // ---------------------------------------------------------------------------
  // Static fetch
  // ---------------------------------------------------------------------------

  static override async fetchForAccount(account: Account): Promise<Array<Record<string, unknown>>> {
    const result = await account.session.get(urljoin(LR5_ENDPOINT, "robots"));
    if (Array.isArray(result)) {
      return result.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null);
    }
    return [];
  }
}
