import type { Account } from "../account.js";
import { Activity, Insight } from "../activity.js";
import {
  LitterBoxCommand,
  type LitterBoxStatusEntry,
  LitterBoxStatus,
  lbStatusFromValue,
} from "../enums.js";
import { InvalidCommandException } from "../exceptions.js";
import { SleepSchedule } from "../sleepSchedule.js";
import { encode, toTimestamp, todayAtTime, urljoin, utcnow } from "../utils.js";
import type { WebSocketProtocol } from "../transport.js";
import { WebSocketMonitor } from "../transport.js";
import { MINIMUM_CYCLES_LEFT_DEFAULT, LitterRobot } from "./litterrobot.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_ENDPOINT = "https://v2.api.whisker.iothings.site";
export const DEFAULT_ENDPOINT_KEY =
  "cDduZE1vajYxbnBSWlA1Q1Z6OXY0VWowYkc3Njl4eTY3NThRUkJQYg==";
const WEBSOCKET_ENDPOINT =
  "https://8s1fz54a82.execute-api.us-east-1.amazonaws.com/prod";

const SLEEP_MODE_ACTIVE = "sleepModeActive";
const SLEEP_MODE_TIME = "sleepModeTime";
const UNIT_STATUS = "unitStatus";
const SLEEP_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours

// ---------------------------------------------------------------------------
// LitterRobot3
// ---------------------------------------------------------------------------

export class LitterRobot3 extends LitterRobot {
  protected override readonly _dataId = "litterRobotId";
  protected override readonly _dataName = "litterRobotNickname";
  protected override readonly _dataSerial = "litterRobotSerial";
  protected override readonly _dataSetupDate = "setupDate";
  protected override _dataCycleCapacity = "cycleCapacity";
  protected override _dataCycleCount = "cycleCount";
  protected override _dataDrawerFullCycles = "cyclesAfterDrawerFull";

  static override readonly VALID_WAIT_TIMES = [3, 7, 15];

  get model(): string { return "Litter-Robot 3"; }

  protected _previousSleepData: string | null = null;

  protected override _path: string;

  private static _wsProtocol: WebSocketProtocol<LitterRobot3> | null = null;

  constructor(data: Record<string, unknown>, account: Account) {
    super(data, account);
    this._assertSerial();
    this._path = urljoin(DEFAULT_ENDPOINT, `users/${account.userId}/robots/${this.id}`);
  }

  // ---------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------

  get cleanCycleWaitTimeMinutes(): number {
    return parseInt(String(this._data["cleanCycleWaitTimeMinutes"] ?? "7"), 16);
  }

  override get cycleCapacity(): number {
    const minCapacity = this.cycleCount + this._minimumCyclesLeft;
    if (this._minimumCyclesLeft < MINIMUM_CYCLES_LEFT_DEFAULT) return minCapacity;
    return Math.max(super.cycleCapacity, minCapacity);
  }

  get isDrawerFullIndicatorTriggered(): boolean {
    return String(this._data["isDFITriggered"] ?? "0") !== "0";
  }

  override get isOnline(): boolean {
    return this.powerStatus !== "NC" && this.status !== LitterBoxStatus.OFFLINE;
  }

  get isSleeping(): boolean {
    const schedule = this._sleepSchedule;
    return schedule !== null && schedule.isActive();
  }

  get isWasteDrawerFull(): boolean {
    return (this.isDrawerFullIndicatorTriggered && this.cycleCount > 9) ||
      this._minimumCyclesLeft < MINIMUM_CYCLES_LEFT_DEFAULT;
  }

  override get nightLightModeEnabled(): boolean {
    return String(this._data["nightLightActive"] ?? "0") !== "0";
  }

  override get panelLockEnabled(): boolean {
    return String(this._data["panelLockActive"] ?? "0") !== "0";
  }

  get sleepModeEnabledDirect(): boolean {
    return String(this._data[SLEEP_MODE_ACTIVE] ?? "0") !== "0";
  }

  get status(): LitterBoxStatusEntry {
    return lbStatusFromValue(this.statusCode);
  }

  get statusCode(): string | null {
    return (this._data[UNIT_STATUS] as string | undefined) ?? null;
  }

  get wasteDrawerLevel(): number {
    const capacity = this.cycleCapacity;
    if (capacity === 0) return 100;
    return Math.floor((this.cycleCount / capacity * 1000 + 0.5) / 1) / 10;
  }

  // ---------------------------------------------------------------------------
  // Sleep info parsing
  // ---------------------------------------------------------------------------

  protected _parseSleepInfo(): void {
    const sleepTime = Number(this._data[SLEEP_MODE_TIME] ?? 0);
    const key = `${this.sleepModeEnabledDirect}.${sleepTime}`;
    if (key === this._previousSleepData) return;
    this._previousSleepData = key;
    this._sleepSchedule = SleepSchedule.fromTimestamp(
      sleepTime,
      SLEEP_DURATION_MS,
      this.sleepModeEnabledDirect,
    );
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  protected async _dispatchCommand(command: string): Promise<boolean> {
    try {
      await this._post(LitterBoxCommand.ENDPOINT, {
        json: { command: `${LitterBoxCommand.PREFIX}${command}` },
      });
      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  override async refresh(): Promise<void> {
    const data = (await this._get()) as Record<string, unknown>;
    this._updateData(data);
  }

  override async resetSettings(): Promise<boolean> {
    return this._dispatchCommand(LitterBoxCommand.DEFAULT_SETTINGS);
  }

  override async setName(name: string): Promise<boolean> {
    const data = (await this._patch(null, { json: { [this._dataName]: name } })) as Record<string, unknown>;
    this._updateData(data);
    return this.name === name;
  }

  override async setSleepMode(value: boolean, sleepTime?: Date | null): Promise<boolean> {
    let newSleepTime: number | undefined;
    if (value && !sleepTime) {
      // Use previous sleep start or now
      const prev = this.sleepModeStartTime;
      const base = prev ?? utcnow();
      sleepTime = base;
    }

    const body: Record<string, unknown> = { sleepModeEnable: value };
    if (sleepTime) {
      newSleepTime = Math.floor(sleepTime.getTime() / 1000);
      body[SLEEP_MODE_TIME] = newSleepTime;
    }

    const data = (await this._patch(null, { json: body })) as Record<string, unknown>;
    this._updateData(data);

    if (newSleepTime === undefined) return true;
    return this._data[SLEEP_MODE_TIME] === newSleepTime;
  }

  override async setWaitTime(waitTime: number): Promise<boolean> {
    if (!LitterRobot3.VALID_WAIT_TIMES.includes(waitTime)) {
      throw new InvalidCommandException(
        `Invalid wait time. Must be one of: ${LitterRobot3.VALID_WAIT_TIMES}, received ${waitTime}`,
      );
    }
    return this._dispatchCommand(`${LitterBoxCommand.WAIT_TIME}${waitTime.toString(16).toUpperCase()}`);
  }

  async resetWasteDrawer(): Promise<boolean> {
    const data = (await this._patch(null, {
      json: {
        [this._dataCycleCount]: 0,
        [this._dataCycleCapacity]: this.cycleCapacity,
        [this._dataDrawerFullCycles]: 0,
      },
    })) as Record<string, unknown>;
    this._updateData(data);
    return this.wasteDrawerLevel === 0;
  }

  async getActivityHistory(limit = 100): Promise<Activity[]> {
    if (limit < 1) throw new InvalidCommandException(`Invalid limit: ${limit}`);
    const data = (await this._get("activity", { params: { limit: String(limit) } })) as Record<string, unknown>;
    const activities = (data["activities"] as Array<Record<string, unknown>>) ?? [];
    return activities
      .map((a) => {
        const ts = toTimestamp(a["timestamp"] as string | undefined);
        if (!ts) return null;
        return new Activity(ts, lbStatusFromValue(a[UNIT_STATUS] as string | undefined));
      })
      .filter((a): a is Activity => a !== null);
  }

  async getInsight(days = 30, timezoneOffset?: number | null): Promise<Insight> {
    const params: Record<string, string> = { days: String(days) };
    if (timezoneOffset != null) params["timezoneOffset"] = String(timezoneOffset);
    const insight = (await this._get("insights", { params })) as Record<string, unknown>;
    return new Insight(
      insight["totalCycles"] as number,
      insight["averageCycles"] as number,
      (insight["cycleHistory"] as Array<Record<string, unknown>>).map((c) => [
        new Date(c["date"] as string),
        c["cyclesCompleted"] as number,
      ]),
    );
  }

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

  static parseWebSocketMessage(data: Record<string, unknown>): Record<string, unknown> | null {
    if (data["type"] === "MODIFY" && data["name"] === "LitterRobot") {
      return data["data"] as Record<string, unknown>;
    }
    return null;
  }

  private static _getWsProtocol(): WebSocketProtocol<LitterRobot3> {
    if (!LitterRobot3._wsProtocol) {
      LitterRobot3._wsProtocol = {
        wsConfigFactory: async (robot) => {
          const auth = await robot._account.getBearerAuthorization();
          return { url: WEBSOCKET_ENDPOINT, headers: { authorization: auth ?? "" } };
        },
        subscribeFactory: async (_robot, ws) => {
          ws.send(JSON.stringify({ action: "ping" }));
        },
        messageHandler: (robot, data) => {
          const parsed = LitterRobot3.parseWebSocketMessage(data);
          if (parsed && String(parsed[robot._dataId]) === robot.id) {
            robot._updateData(parsed);
          }
        },
      };
    }
    return LitterRobot3._wsProtocol;
  }

  protected override _buildTransport(): WebSocketMonitor<LitterRobot3> {
    return this._account.getMonitorFor(LitterRobot3, LitterRobot3._getWsProtocol()) as WebSocketMonitor<LitterRobot3>;
  }

  // ---------------------------------------------------------------------------
  // Static fetch
  // ---------------------------------------------------------------------------

  static override async fetchForAccount(account: Account): Promise<Array<Record<string, unknown>>> {
    const result = await account.session.get(
      urljoin(DEFAULT_ENDPOINT, `users/${account.userId}/robots`),
    );
    if (Array.isArray(result)) {
      return result.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null);
    }
    return [];
  }
}
