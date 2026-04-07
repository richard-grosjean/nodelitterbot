import type { Account } from "../account.js";
import { Activity, Insight } from "../activity.js";
import {
  BrightnessLevel,
  GlobeMotorFaultStatus,
  globeMotorFaultFromRaw,
  HopperStatus,
  type LitterBoxStatusEntry,
  LitterBoxStatus,
  lbStatusFromValue,
  LitterLevelState,
  LitterRobot4Command,
  NightLightMode,
} from "../enums.js";
import { InvalidCommandException, LitterRobotException } from "../exceptions.js";
import { SleepSchedule } from "../sleepSchedule.js";
import {
  calculateLitterLevel,
  encode,
  toEnum,
  toTimestamp,
  urljoin,
  utcnow,
} from "../utils.js";
import type { WebSocketProtocol } from "../transport.js";
import { WebSocketMonitor } from "../transport.js";
import { LitterRobot } from "./litterrobot.js";
import { LITTER_ROBOT_4_MODEL } from "./models.js";

export const LR4_ENDPOINT = "https://lr4.iothings.site/graphql";

// ---------------------------------------------------------------------------
// Status maps
// ---------------------------------------------------------------------------

const LR4_STATUS_MAP: Record<string, LitterBoxStatusEntry> = {
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

const CYCLE_STATE_STATUS_MAP: Record<string, LitterBoxStatusEntry> = {
  CYCLE_STATE_CAT_DETECT: LitterBoxStatus.CAT_SENSOR_INTERRUPTED,
  CYCLE_STATE_PAUSE: LitterBoxStatus.PAUSED,
};

const DISPLAY_CODE_STATUS_MAP: Record<string, LitterBoxStatusEntry> = {
  DC_CAT_DETECT: LitterBoxStatus.CAT_DETECTED,
};

const ACTIVITY_STATUS_MAP: Record<string, LitterBoxStatusEntry | string> = {
  bonnetRemovedYes: LitterBoxStatus.BONNET_REMOVED,
  catDetectStuckLaser: LitterBoxStatus.CAT_SENSOR_FAULT,
  catWeight: "Pet Weight Recorded",
  DFIFullFlagOn: LitterBoxStatus.DRAWER_FULL,
  litterHopperDispensed: "Litter Dispensed",
  odometerCleanCycles: "Clean Cycles",
  powerTypeDC: "Battery Backup",
  robotCycleStateCatDetect: LitterBoxStatus.CAT_SENSOR_INTERRUPTED,
  robotCycleStatusDump: LitterBoxStatus.CLEAN_CYCLE,
  robotCycleStatusIdle: LitterBoxStatus.CLEAN_CYCLE_COMPLETE,
  robotStatusCatDetect: LitterBoxStatus.CAT_DETECTED,
};

const LITTER_LEVEL_EMPTY = 500;

// ---------------------------------------------------------------------------
// LitterRobot4
// ---------------------------------------------------------------------------

export class LitterRobot4 extends LitterRobot {
  protected override readonly _dataId = "unitId";
  protected override readonly _dataName = "name";
  protected override readonly _dataSerial = "serial";
  protected override readonly _dataSetupDate = "setupDateTime";
  protected override _dataCycleCapacity = "DFINumberOfCycles";
  protected override _dataCycleCount = "odometerCleanCycles";
  protected override _dataDrawerFullCycles = "DFIFullCounter";
  protected override _dataPowerStatus = "unitPowerType";

  static override readonly VALID_WAIT_TIMES = [3, 7, 15, 25, 30];

  protected override readonly _commandClean = LitterRobot4Command.CLEAN_CYCLE;
  protected override readonly _commandNightLightOff = LitterRobot4Command.NIGHT_LIGHT_MODE_OFF;
  protected override readonly _commandNightLightOn = LitterRobot4Command.NIGHT_LIGHT_MODE_AUTO;
  protected override readonly _commandPanelLockOff = LitterRobot4Command.KEY_PAD_LOCK_OUT_OFF;
  protected override readonly _commandPanelLockOn = LitterRobot4Command.KEY_PAD_LOCK_OUT_ON;
  protected override readonly _commandPowerOff = LitterRobot4Command.POWER_OFF;
  protected override readonly _commandPowerOn = LitterRobot4Command.POWER_ON;

  protected override readonly _path = LR4_ENDPOINT;

  private _litterLevel = LITTER_LEVEL_EMPTY;
  private _litterLevelExp: Date | null = null;
  private _firmwareDetails: Record<string, unknown> | null = null;
  private _firmwareDetailsRequested: Date | null = null;
  private _previousSleepData: Record<string, unknown> | null = null;
  private _wsSubscriptionId: string | null = null;

  private static _wsProtocol: WebSocketProtocol<LitterRobot4> | null = null;

  constructor(data: Record<string, unknown>, account: Account) {
    super(data, account);
    this._assertSerial();
  }

  get model(): string { return "Litter-Robot 4"; }

  // ---------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------

  get cleanCycleWaitTimeMinutes(): number {
    return Number(this._data["cleanCycleWaitTime"] ?? 7);
  }

  get firmware(): string {
    return `ESP: ${this._data["espFirmware"]} / PIC: ${this._data["picFirmwareVersion"]} / TOF: ${this._data["laserBoardFirmwareVersion"]}`;
  }

  get firmwareUpdateStatus(): string {
    return String(this._data["firmwareUpdateStatus"] ?? "UNKNOWN");
  }

  get firmwareUpdateTriggered(): boolean {
    return this._data["isFirmwareUpdateTriggered"] === true;
  }

  get globeMotorFaultStatus(): GlobeMotorFaultStatus {
    return globeMotorFaultFromRaw(this._data["globeMotorFaultStatus"] as string | undefined);
  }

  get globeMotorRetractFaultStatus(): GlobeMotorFaultStatus {
    return globeMotorFaultFromRaw(this._data["globeMotorRetractFaultStatus"] as string | undefined);
  }

  get hopperStatus(): HopperStatus | undefined {
    return toEnum(HopperStatus, this._data["hopperStatus"]);
  }

  get isDrawerFullIndicatorTriggered(): boolean {
    return this._data["isDFIFull"] === true;
  }

  get isHopperRemoved(): boolean {
    return this._data["isHopperRemoved"] === true;
  }

  override get isOnline(): boolean {
    return this._data["isOnline"] === true;
  }

  override get isOnboarded(): boolean {
    return this._data["isOnboarded"] === true;
  }

  get isSleeping(): boolean {
    return String(this._data["sleepStatus"] ?? "WAKE") !== "WAKE";
  }

  get isWasteDrawerFull(): boolean {
    return this._data["isDFIFull"] === true;
  }

  get litterLevel(): number {
    return Number(this._data["litterLevelPercentage"] ?? 0) * 100;
  }

  get litterLevelCalculated(): number {
    const isCleaning = this._data["robotStatus"] === "ROBOT_CLEAN";
    const newLevel = Number(this._data["litterLevel"] ?? LITTER_LEVEL_EMPTY);
    const [level, exp, percent] = calculateLitterLevel(isCleaning, newLevel, this._litterLevel, this._litterLevelExp);
    this._litterLevel = level;
    this._litterLevelExp = exp;
    return percent;
  }

  get litterLevelState(): LitterLevelState | undefined {
    return toEnum(LitterLevelState, this._data["litterLevelState"]);
  }

  get nightLightBrightness(): number {
    return Number(this._data["nightLightBrightness"] ?? 0);
  }

  get nightLightLevel(): BrightnessLevel | undefined {
    return toEnum(BrightnessLevel, this.nightLightBrightness, false);
  }

  get nightLightMode(): NightLightMode | undefined {
    return toEnum(NightLightMode, this._data["nightLightMode"]);
  }

  override get nightLightModeEnabled(): boolean {
    return String(this._data["nightLightMode"] ?? "OFF") !== "OFF";
  }

  get panelBrightness(): BrightnessLevel | undefined {
    const b = this._data["panelBrightnessHigh"];
    const values = Object.values(BrightnessLevel).filter((v) => typeof v === "number");
    if (values.includes(b as number)) return b as BrightnessLevel;
    return undefined;
  }

  override get panelLockEnabled(): boolean {
    return this._data["isKeypadLockout"] === true;
  }

  get petWeight(): number {
    return Number(this._data["catWeight"] ?? 0);
  }

  get scoopsSavedCount(): number {
    return Number(this._data["scoopsSavedCount"] ?? 0);
  }

  get status(): LitterBoxStatusEntry {
    if (!this.isOnline) return LitterBoxStatus.OFFLINE;
    const cycleState = this._data["robotCycleState"] as string | undefined;
    if (cycleState && CYCLE_STATE_STATUS_MAP[cycleState]) {
      return CYCLE_STATE_STATUS_MAP[cycleState]!;
    }
    const robotStatus = this._data["robotStatus"] as string | undefined;
    let s = (robotStatus ? LR4_STATUS_MAP[robotStatus] : undefined) ?? LitterBoxStatus.UNKNOWN;
    if (s === LitterBoxStatus.READY) {
      const displayCode = this._data["displayCode"] as string | undefined;
      if (displayCode && DISPLAY_CODE_STATUS_MAP[displayCode]) {
        return DISPLAY_CODE_STATUS_MAP[displayCode]!;
      }
      if (this.isWasteDrawerFull) return LitterBoxStatus.DRAWER_FULL;
    }
    return s;
  }

  get statusCode(): string | null {
    if (this.status !== LitterBoxStatus.UNKNOWN) return this.status.value;
    return (this._data["robotStatus"] as string | undefined) ?? null;
  }

  get surfaceType(): string | undefined {
    return this._data["surfaceType"] as string | undefined;
  }

  override get timezone(): string | null {
    return (this._data["unitTimezone"] as string | undefined) ?? null;
  }

  get usbFaultStatus(): string | undefined {
    return this._data["USBFaultStatus"] as string | undefined;
  }

  get wasteDrawerLevel(): number {
    return Number(this._data["DFILevelPercent"] ?? 0);
  }

  get wifiModeStatus(): string | undefined {
    return this._data["wifiModeStatus"] as string | undefined;
  }

  // ---------------------------------------------------------------------------
  // Sleep info
  // ---------------------------------------------------------------------------

  protected _parseSleepInfo(): void {
    const sleepData = (this._data["weekdaySleepModeEnabled"] as Record<string, unknown> | undefined) ?? {};
    if (JSON.stringify(sleepData) === JSON.stringify(this._previousSleepData)) return;
    this._previousSleepData = sleepData;
    this._sleepSchedule = SleepSchedule.parse(sleepData);
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  protected async _dispatchCommand(command: string, value?: unknown): Promise<boolean> {
    try {
      const variables: Record<string, unknown> = { serial: this.serial, command };
      if (value !== undefined) variables["value"] = value;

      const data = (await this._post(null, {
        json: {
          query: `
            mutation sendCommand(
              $serial: String!
              $command: String!
              $value: String
              $commandSource: String
            ) {
              sendLitterRobot4Command(
                input: {
                  serial: $serial
                  command: $command
                  value: $value
                  commandSource: $commandSource
                }
              )
            }
          `,
          variables,
        },
      })) as Record<string, unknown>;

      const result = (data["data"] as Record<string, unknown> | undefined)?.["sendLitterRobot4Command"] as string | undefined;
      if (result && result.includes("Error")) throw new InvalidCommandException(result);

      const errors = (data["errors"] as Array<Record<string, unknown>> | undefined) ?? [];
      if (errors.length > 0) {
        throw new InvalidCommandException(errors.map((e) => String(e["message"] ?? "")).join(", "));
      }
      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  override async refresh(): Promise<void> {
    const data = (await this._post(null, {
      json: {
        query: `query GetLR4($serial: String!) { getLitterRobot4BySerial(serial: $serial) ${LITTER_ROBOT_4_MODEL} }`,
        variables: { serial: this.serial },
      },
    })) as Record<string, unknown>;
    this._updateData((data["data"] as Record<string, unknown>)?.["getLitterRobot4BySerial"] as Record<string, unknown>);
  }

  override async setName(name: string): Promise<boolean> {
    const data = (await this._post(null, {
      json: {
        query: `
          mutation rename($serial: String!, $name: String) {
            updateLitterRobot4(input: { serial: $serial name: $name }) { name }
          }
        `,
        variables: { serial: this.serial, name },
      },
    })) as Record<string, unknown>;
    const updated = (data["data"] as Record<string, unknown>)?.["updateLitterRobot4"] as Record<string, unknown>;
    this._updateData(updated, true);
    return this.name === name;
  }

  async setNightLightBrightness(brightness: number | BrightnessLevel): Promise<boolean> {
    const levels = Object.values(BrightnessLevel).filter((v) => typeof v === "number");
    if (!levels.includes(brightness as number)) {
      throw new InvalidCommandException(`Invalid brightness: ${brightness}`);
    }
    return this._dispatchCommand(
      LitterRobot4Command.SET_NIGHT_LIGHT_VALUE,
      JSON.stringify({ nightLightPower: Number(brightness) }),
    );
  }

  async setNightLightMode(mode: NightLightMode): Promise<boolean> {
    const modeToCommand: Record<string, string> = {
      [NightLightMode.ON]: LitterRobot4Command.NIGHT_LIGHT_MODE_ON,
      [NightLightMode.OFF]: LitterRobot4Command.NIGHT_LIGHT_MODE_OFF,
      [NightLightMode.AUTO]: LitterRobot4Command.NIGHT_LIGHT_MODE_AUTO,
    };
    return this._dispatchCommand(modeToCommand[mode]!);
  }

  async setPanelBrightness(brightness: BrightnessLevel): Promise<boolean> {
    const levelToCommand: Record<number, string> = {
      [BrightnessLevel.LOW]: LitterRobot4Command.PANEL_BRIGHTNESS_LOW,
      [BrightnessLevel.MEDIUM]: LitterRobot4Command.PANEL_BRIGHTNESS_MEDIUM,
      [BrightnessLevel.HIGH]: LitterRobot4Command.PANEL_BRIGHTNESS_HIGH,
    };
    return this._dispatchCommand(levelToCommand[brightness]!);
  }

  override async setWaitTime(waitTime: number): Promise<boolean> {
    if (!LitterRobot4.VALID_WAIT_TIMES.includes(waitTime)) {
      throw new InvalidCommandException(
        `Invalid wait time. Must be one of: ${LitterRobot4.VALID_WAIT_TIMES}, received ${waitTime}`,
      );
    }
    return this._dispatchCommand(
      LitterRobot4Command.SET_CLUMP_TIME,
      JSON.stringify({ clumpTime: waitTime }),
    );
  }

  async reset(): Promise<boolean> {
    return this._dispatchCommand(LitterRobot4Command.SHORT_RESET_PRESS);
  }

  async getActivityHistory(limit = 100): Promise<Activity[]> {
    if (limit < 1) throw new InvalidCommandException(`Invalid limit: ${limit}`);
    const data = (await this._post(null, {
      json: {
        query: `
          query GetLR4Activity($serial: String!, $limit: Int, $consumer: String) {
            getLitterRobot4Activity(serial: $serial limit: $limit consumer: $consumer) {
              serial measure timestamp value actionValue originalHex valueString stateString consumer commandSource
            }
          }
        `,
        variables: { serial: this.serial, limit, consumer: "app" },
      },
    })) as Record<string, unknown>;

    const activities = ((data["data"] as Record<string, unknown>)?.["getLitterRobot4Activity"] as Array<Record<string, unknown>>) ?? [];
    if (!Array.isArray(activities)) throw new LitterRobotException("Activity history could not be retrieved.");

    return activities.flatMap((activity) => {
      const ts = toTimestamp(activity["timestamp"] as string | undefined);
      if (!ts) return [];
      return [new Activity(ts, this._parseActivity(activity))];
    });
  }

  private _parseActivity(activity: Record<string, unknown>): LitterBoxStatusEntry | string {
    const value = activity["value"] as string | undefined ?? "";
    let action: LitterBoxStatusEntry | string = ACTIVITY_STATUS_MAP[value] ?? value;
    if (value === "catWeight") action = `${action}: ${activity["actionValue"]} lbs`;
    if (value === this._dataCycleCount) action = `${action}: ${activity["actionValue"]}`;
    if (value === "litterHopperDispensed") action = `${action}: ${activity["actionValue"]}`;
    return action;
  }

  async getInsight(days = 30, timezoneOffset?: number | null): Promise<Insight> {
    const startTimestamp = new Date(utcnow().getTime() - days * 86_400_000).toISOString();
    const data = (await this._post(null, {
      json: {
        query: `
          query GetLR4Insights($serial: String!, $startTimestamp: String, $timezoneOffset: Int) {
            getLitterRobot4Insights(serial: $serial startTimestamp: $startTimestamp timezoneOffset: $timezoneOffset) {
              totalCycles averageCycles
              cycleHistory { date numberOfCycles }
              totalCatDetections
            }
          }
        `,
        variables: { serial: this.serial, startTimestamp, timezoneOffset: timezoneOffset ?? null },
      },
    })) as Record<string, unknown>;

    const insight = ((data["data"] as Record<string, unknown>)?.["getLitterRobot4Insights"]) as Record<string, unknown> | null;
    if (!insight) throw new LitterRobotException("Insight data could not be retrieved.");

    return new Insight(
      insight["totalCycles"] as number,
      insight["averageCycles"] as number,
      (insight["cycleHistory"] as Array<Record<string, unknown>>).map((c) => [
        new Date(c["date"] as string),
        c["numberOfCycles"] as number,
      ]),
    );
  }

  async getFirmwareDetails(forceCheck = false): Promise<Record<string, unknown> | null> {
    const FIFTEEN_MIN = 15 * 60_000;
    const now = utcnow();
    if (
      !forceCheck &&
      this._firmwareDetails &&
      this._firmwareDetailsRequested &&
      now.getTime() - this._firmwareDetailsRequested.getTime() < FIFTEEN_MIN
    ) {
      return this._firmwareDetails;
    }

    const data = (await this._post(null, {
      json: {
        query: `
          query getFirmwareDetails($serial: String!) {
            litterRobot4CompareFirmwareVersion(serial: $serial) {
              isEspFirmwareUpdateNeeded isPicFirmwareUpdateNeeded isLaserboardFirmwareUpdateNeeded
              latestFirmware { espFirmwareVersion picFirmwareVersion laserBoardFirmwareVersion }
            }
          }
        `,
        variables: { serial: this.serial },
      },
    })) as Record<string, unknown>;

    this._firmwareDetails = ((data["data"] as Record<string, unknown> | undefined)?.["litterRobot4CompareFirmwareVersion"] as Record<string, unknown>) ?? null;
    this._firmwareDetailsRequested = now;
    return this._firmwareDetails;
  }

  async toggleHopper(isRemoved: boolean): Promise<boolean> {
    const data = (await this._post(null, {
      json: {
        query: `
          mutation ToggleHopper($serial: String!, $isRemoved: Boolean!) {
            toggleHopper(serial: $serial, isRemoved: $isRemoved) { success }
          }
        `,
        variables: { serial: this.serial, isRemoved },
      },
    })) as Record<string, unknown>;

    const success = Boolean(((data["data"] as Record<string, unknown>)?.["toggleHopper"] as Record<string, unknown>)?.["success"]);
    if (success) {
      this._updateData({
        isHopperRemoved: isRemoved,
        hopperStatus: isRemoved ? "DISABLED" : "ENABLED",
      }, true);
    }
    return success;
  }

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

  static parseWebSocketMessage(data: Record<string, unknown>): Record<string, unknown> | null {
    if (data["type"] === "data") {
      const payload = (data["payload"] as Record<string, unknown>)?.["data"] as Record<string, unknown> | undefined;
      return payload?.["litterRobot4StateSubscriptionBySerial"] as Record<string, unknown> ?? null;
    }
    if (data["type"] === "error") console.error(data);
    return null;
  }

  private async _wsConfigFactory(): Promise<{ url: string; headers?: Record<string, string> }> {
    const auth = await this._account.getBearerAuthorization();
    const headerPayload = encode({ Authorization: auth, host: "lr4.iothings.site" });
    const emptyPayload = encode({});
    return {
      url: `${LR4_ENDPOINT}/realtime?header=${headerPayload}&payload=${emptyPayload}`,
      headers: { "sec-websocket-protocol": "graphql-ws" },
    };
  }

  private async _wsSubscribe(ws: WebSocket): Promise<void> {
    this._wsSubscriptionId = crypto.randomUUID();
    const auth = await this._account.getBearerAuthorization();
    ws.send(JSON.stringify({
      id: this._wsSubscriptionId,
      payload: {
        data: JSON.stringify({
          query: `subscription GetLR4($serial: String!) { litterRobot4StateSubscriptionBySerial(serial: $serial) ${LITTER_ROBOT_4_MODEL} }`,
          variables: { serial: this.serial },
        }),
        extensions: { authorization: { Authorization: auth, host: "lr4.iothings.site" } },
      },
      type: "start",
    }));
  }

  private async _wsUnsubscribe(ws: WebSocket): Promise<void> {
    if (this._wsSubscriptionId) {
      ws.send(JSON.stringify({ id: this._wsSubscriptionId, type: "stop" }));
      this._wsSubscriptionId = null;
    }
  }

  private static _getWsProtocol(): WebSocketProtocol<LitterRobot4> {
    if (!LitterRobot4._wsProtocol) {
      LitterRobot4._wsProtocol = {
        wsConfigFactory: (robot) => robot._wsConfigFactory(),
        subscribeFactory: (robot, ws) => robot._wsSubscribe(ws),
        unsubscribeFactory: (robot, ws) => robot._wsUnsubscribe(ws),
        messageHandler: (robot, data) => {
          const parsed = LitterRobot4.parseWebSocketMessage(data);
          if (parsed && String(parsed["unitId"]) === robot.id) {
            robot._updateData(parsed);
          }
        },
      };
    }
    return LitterRobot4._wsProtocol;
  }

  protected override _buildTransport(): WebSocketMonitor<LitterRobot4> {
    return this._account.getMonitorFor(LitterRobot4, LitterRobot4._getWsProtocol()) as WebSocketMonitor<LitterRobot4>;
  }

  // ---------------------------------------------------------------------------
  // Static fetch
  // ---------------------------------------------------------------------------

  static override async fetchForAccount(account: Account): Promise<Array<Record<string, unknown>>> {
    const result = (await account.session.post(LR4_ENDPOINT, {
      json: {
        query: `query GetLR4($userId: String!) { getLitterRobot4ByUser(userId: $userId) ${LITTER_ROBOT_4_MODEL} }`,
        variables: { userId: account.userId },
      },
    })) as Record<string, unknown>;

    const robots = ((result["data"] as Record<string, unknown> | undefined)?.["getLitterRobot4ByUser"]) as unknown[];
    if (Array.isArray(robots)) {
      return robots.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null);
    }
    return [];
  }
}
