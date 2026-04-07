import type { Account } from "../account.js";
import { FeederRobotCommand } from "../enums.js";
import { InvalidCommandException } from "../exceptions.js";
import { decode, toTimestamp, utcnow } from "../utils.js";
import type { WebSocketProtocol } from "../transport.js";
import { WebSocketMonitor } from "../transport.js";
import { Robot } from "./index.js";
import { getFeederRobotModel } from "./models.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FEEDER_ENDPOINT = "https://cognito.hasura.iothings.site/v1/graphql";
const COMMAND_ENDPOINT =
  "https://42nk7qrhdg.execute-api.us-east-1.amazonaws.com/prod/command/feeder";
const COMMAND_ENDPOINT_KEY = decode("dzJ0UEZiamxQMTNHVW1iOGRNalVMNUIyWXlQVkQzcEo3RXk2Zno4dg==");

const FOOD_LEVEL_MAP: Record<number, number> = {
  9: 100, 8: 70, 7: 60, 6: 50, 5: 40, 4: 30, 3: 20, 2: 10, 1: 5, 0: 0,
};

const MEAL_INSERT_SIZE_CUPS_MAP: Record<number, number> = { 0: 1 / 4, 1: 1 / 8 };
const MEAL_INSERT_SIZE_CUPS_REVERSE_MAP = new Map<number, number>(
  Object.entries(MEAL_INSERT_SIZE_CUPS_MAP).map(([k, v]) => [v, Number(k)]),
);

export const VALID_MEAL_INSERT_SIZES = Object.values(MEAL_INSERT_SIZE_CUPS_MAP);

const WEEKDAY_MAP: Record<string, number> = {
  Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
};

// ---------------------------------------------------------------------------
// FeederRobot
// ---------------------------------------------------------------------------

export class FeederRobot extends Robot {
  protected override readonly _dataId = "id";
  protected override readonly _dataName = "name";
  protected override readonly _dataSerial = "serial";
  protected override readonly _dataSetupDate = "created_at";
  protected override readonly _path = FEEDER_ENDPOINT;

  private _lastUpdatedAt: string | null = null;
  private _nextFeeding: Date | null = null;
  private _wsSubscriptionId: string | null = null;

  private static _wsProtocol: WebSocketProtocol<FeederRobot> | null = null;

  constructor(data: Record<string, unknown>, account: Account) {
    super(data, account);
    this._assertSerial();
  }

  get model(): string { return "Feeder-Robot"; }

  // ---------------------------------------------------------------------------
  // Helper to read from data.state.info
  // ---------------------------------------------------------------------------

  private _stateInfo<T>(key: string, defaultValue?: T): T | unknown {
    const state = this._data["state"] as Record<string, unknown> | undefined;
    const info = state?.["info"] as Record<string, unknown> | undefined;
    return info?.[key] ?? defaultValue;
  }

  // ---------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------

  get firmware(): string {
    return String(this._stateInfo("fwVersion") ?? "");
  }

  get foodLevel(): number {
    const level = Number(this._stateInfo("level") ?? 0);
    return FOOD_LEVEL_MAP[level] ?? 0;
  }

  get gravityModeEnabled(): boolean {
    return Boolean(this._stateInfo("gravity"));
  }

  override get isOnboarded(): boolean {
    return Boolean(this._stateInfo("onBoarded"));
  }

  override get isOnline(): boolean {
    return Boolean(this._stateInfo("online"));
  }

  get lastFeeding(): Record<string, unknown> | null {
    const meal = this.lastMeal;
    const snack = this.lastSnack;
    if (!snack) return meal;
    if (!meal) return snack;
    const mealTs = (meal["timestamp"] as Date).getTime();
    const snackTs = (snack["timestamp"] as Date).getTime();
    return mealTs >= snackTs ? meal : snack;
  }

  get lastMeal(): Record<string, unknown> | null {
    const meals = this._data["feeding_meal"] as Array<Record<string, unknown>> | undefined;
    if (!meals?.length) return null;
    const m = meals[0]!;
    return {
      timestamp: toTimestamp(m["timestamp"] as string),
      amount: Number(m["amount"]) * Number(m["meal_total_portions"]),
      name: m["meal_name"],
    };
  }

  get lastSnack(): Record<string, unknown> | null {
    const snacks = this._data["feeding_snack"] as Array<Record<string, unknown>> | undefined;
    if (!snacks?.length) return null;
    const s = snacks[0]!;
    return {
      timestamp: toTimestamp(s["timestamp"] as string),
      amount: Number(s["amount"]),
      name: "snack",
    };
  }

  get mealInsertSize(): number {
    const size = Number(this._stateInfo("mealInsertSize") ?? 0);
    return MEAL_INSERT_SIZE_CUPS_MAP[size] ?? 0;
  }

  get nextFeeding(): Date | null {
    if (this._nextFeeding && this._nextFeeding < utcnow()) {
      this._calculateNextFeeding();
    }
    return this._nextFeeding;
  }

  override get nightLightModeEnabled(): boolean {
    return Boolean(this._stateInfo("autoNightMode"));
  }

  override get panelLockEnabled(): boolean {
    return Boolean(this._stateInfo("panelLockout"));
  }

  override get powerStatus(): string {
    if (Boolean(this._stateInfo("acPower"))) return "AC";
    if (Boolean(this._stateInfo("dcPower"))) return "DC";
    return "NC";
  }

  override get timezone(): string {
    return String(this._data["timezone"] ?? "UTC");
  }

  get updatedAt(): string {
    const state = this._data["state"] as Record<string, unknown> | undefined;
    return String(state?.["updated_at"] ?? "");
  }

  getFoodDispensedSince(start: Date): number {
    const meals = (this._data["feeding_meal"] as Array<Record<string, unknown>> | undefined) ?? [];
    const snacks = (this._data["feeding_snack"] as Array<Record<string, unknown>> | undefined) ?? [];
    const all = [...meals, ...snacks];
    return all.reduce((sum, f) => {
      const ts = toTimestamp(f["timestamp"] as string | undefined);
      if (!ts || ts < start) return sum;
      return sum + Number(f["amount"]) * Number(f["meal_total_portions"] ?? 1);
    }, 0);
  }

  // ---------------------------------------------------------------------------
  // Next feeding calculation
  // ---------------------------------------------------------------------------

  private _calculateNextFeeding(): void {
    if (this.gravityModeEnabled) {
      this._nextFeeding = null;
      return;
    }
    const state = this._data["state"] as Record<string, unknown> | undefined;
    const schedule = state?.["active_schedule"] as Record<string, unknown> | undefined;
    if (!schedule?.["meals"]) {
      this._nextFeeding = null;
      return;
    }

    const tz = this.timezone;
    const now = new Date();
    let nextMealTime: Date | null = null;

    for (const meal of (schedule["meals"] as Array<Record<string, unknown>>)) {
      if (meal["paused"]) continue;

      const skip = meal["skip"] as string | undefined;
      if (skip && skip !== "0000-01-01T00:00:00.000") {
        const skipDt = new Date(skip);
        if (skipDt >= new Date(now.toDateString())) continue;
      }

      const mealHour = Number(meal["hour"]);
      const mealMinute = Number(meal["minute"]);

      for (const day of (meal["days"] as string[])) {
        const targetWeekday = WEEKDAY_MAP[day];
        if (targetWeekday === undefined) continue;
        let daysAhead = (targetWeekday - now.getDay() + 7) % 7;

        if (daysAhead === 0) {
          const nowMins = now.getHours() * 60 + now.getMinutes();
          const mealMins = mealHour * 60 + mealMinute;
          if (mealMins <= nowMins) daysAhead = 7;
        }

        const feedDate = new Date(now);
        feedDate.setDate(feedDate.getDate() + daysAhead);
        feedDate.setHours(mealHour, mealMinute, 0, 0);

        if (!nextMealTime || feedDate < nextMealTime) {
          nextMealTime = feedDate;
        }
      }
    }

    this._nextFeeding = nextMealTime;
  }

  // ---------------------------------------------------------------------------
  // Data update override
  // ---------------------------------------------------------------------------

  override _updateData(
    data: Record<string, unknown>,
    partial = false,
    callback?: () => void,
  ): void {
    const cb = () => {
      callback?.();
      if (this._lastUpdatedAt !== this.updatedAt) {
        this._calculateNextFeeding();
        this._lastUpdatedAt = this.updatedAt;
      }
    };
    super._updateData(data, partial, cb);
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  private async _dispatchFeederCommand(command: string, value: boolean): Promise<boolean> {
    try {
      await this._account.session.request("POST", COMMAND_ENDPOINT, {
        json: {
          command,
          id: crypto.randomUUID(),
          serial: this.serial,
          value: value ? 1 : 0,
        },
        headers: { "x-api-key": COMMAND_ENDPOINT_KEY },
      });
      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  async giveSnack(): Promise<boolean> {
    return this._dispatchFeederCommand(FeederRobotCommand.GIVE_SNACK, true);
  }

  override async refresh(): Promise<void> {
    const FEEDER_ROBOT_MODEL = getFeederRobotModel();
    const data = (await this._post(null, {
      json: {
        query: `query GetFeeder($id: Int!) { feeder_unit_by_pk(id: $id) ${FEEDER_ROBOT_MODEL} }`,
        variables: { id: Number(this.id) },
      },
    })) as Record<string, unknown>;
    const robot = ((data["data"] as Record<string, unknown>)?.["feeder_unit_by_pk"]) as Record<string, unknown>;
    this._updateData(robot);
  }

  async setMealInsertSize(mealInsertSize: number): Promise<boolean> {
    const value = MEAL_INSERT_SIZE_CUPS_REVERSE_MAP.get(mealInsertSize);
    if (value === undefined) {
      throw new InvalidCommandException(
        `Only meal insert sizes of ${Array.from(MEAL_INSERT_SIZE_CUPS_REVERSE_MAP.keys())} are supported.`,
      );
    }
    const state = this._data["state"] as Record<string, unknown>;
    const data = (await this._post(null, {
      json: {
        query: `
          mutation UpdateFeederState($id: Int!, $state: jsonb) {
            update_feeder_unit_state_by_pk(pk_columns: {id: $id}, _append: {info: $state}) {
              info updated_at
            }
          }
        `,
        variables: {
          id: (state as Record<string, unknown>)["id"],
          state: {
            mealInsertSize: value,
            historyInvalidationDate: utcnow().toISOString(),
          },
        },
      },
    })) as Record<string, unknown>;
    const updated = (data["data"] as Record<string, unknown>)?.["update_feeder_unit_state_by_pk"] as Record<string, unknown>;
    this._updateData({ ...this._data, state: { ...(this._data["state"] as Record<string, unknown>), ...updated } });
    return this.mealInsertSize === mealInsertSize;
  }

  override async setName(name: string): Promise<boolean> {
    const data = (await this._post(null, {
      json: {
        query: `
          mutation UpdateFeeder($id: Int!, $name: String!) {
            update_feeder_unit_by_pk(pk_columns: {id: $id}, _set: {name: $name}) { name }
          }
        `,
        variables: { id: Number(this.id), name },
      },
    })) as Record<string, unknown>;
    const updated = (data["data"] as Record<string, unknown>)?.["update_feeder_unit_by_pk"] as Record<string, unknown>;
    this._updateData({ ...this._data, ...updated });
    return this.name === name;
  }

  async setGravityMode(value: boolean): Promise<boolean> {
    if (await this._dispatchFeederCommand(FeederRobotCommand.SET_GRAVITY_MODE, value)) {
      const data = JSON.parse(JSON.stringify(this._data)) as Record<string, unknown>;
      const state = data["state"] as Record<string, unknown>;
      const info = state["info"] as Record<string, unknown>;
      info["gravity"] = value;
      (state["updated_at"] as unknown) = utcnow().toISOString();
      this._updateData(data);
    }
    return this.gravityModeEnabled === value;
  }

  override async setNightLight(value: boolean): Promise<boolean> {
    if (await this._dispatchFeederCommand(FeederRobotCommand.SET_AUTO_NIGHT_MODE, value)) {
      const data = JSON.parse(JSON.stringify(this._data)) as Record<string, unknown>;
      ((data["state"] as Record<string, unknown>)["info"] as Record<string, unknown>)["autoNightMode"] = value;
      this._updateData(data);
    }
    return this.nightLightModeEnabled === value;
  }

  override async setPanelLockout(value: boolean): Promise<boolean> {
    if (await this._dispatchFeederCommand(FeederRobotCommand.SET_PANEL_LOCKOUT, value)) {
      const data = JSON.parse(JSON.stringify(this._data)) as Record<string, unknown>;
      ((data["state"] as Record<string, unknown>)["info"] as Record<string, unknown>)["panelLockout"] = value;
      this._updateData(data);
    }
    return this.panelLockEnabled === value;
  }

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

  static parseWebSocketMessage(data: Record<string, unknown>): Record<string, unknown> | null {
    if (data["type"] === "data") {
      return ((data["payload"] as Record<string, unknown>)?.["data"] as Record<string, unknown>)?.["feeder_unit_by_pk"] as Record<string, unknown> ?? null;
    }
    if (data["type"] === "error") console.error(data);
    return null;
  }

  private static _getWsProtocol(): WebSocketProtocol<FeederRobot> {
    if (!FeederRobot._wsProtocol) {
      FeederRobot._wsProtocol = {
        wsConfigFactory: async (robot) => {
          const auth = await robot._account.getBearerAuthorization();
          return {
            url: FEEDER_ENDPOINT,
            headers: { "sec-websocket-protocol": "graphql-ws" },
            connectionInit: {
              type: "connection_init",
              payload: { headers: { Authorization: auth } },
            },
          };
        },
        subscribeFactory: async (robot, ws) => {
          robot._wsSubscriptionId = crypto.randomUUID();
          const FEEDER_ROBOT_MODEL = getFeederRobotModel();
          ws.send(JSON.stringify({
            type: "start",
            id: robot._wsSubscriptionId,
            payload: {
              query: `subscription GetFeeder($id: Int!) { feeder_unit_by_pk(id: $id) ${FEEDER_ROBOT_MODEL} }`,
              variables: { id: Number(robot.id) },
            },
          }));
        },
        unsubscribeFactory: async (robot, ws) => {
          if (robot._wsSubscriptionId) {
            ws.send(JSON.stringify({ id: robot._wsSubscriptionId, type: "stop" }));
            robot._wsSubscriptionId = null;
          }
        },
        messageHandler: (robot, data) => {
          const parsed = FeederRobot.parseWebSocketMessage(data);
          if (parsed && String(parsed["id"]) === robot.id) {
            robot._updateData(parsed);
          }
        },
      };
    }
    return FeederRobot._wsProtocol;
  }

  protected override _buildTransport(): WebSocketMonitor<FeederRobot> {
    return this._account.getMonitorFor(FeederRobot, FeederRobot._getWsProtocol()) as WebSocketMonitor<FeederRobot>;
  }

  // ---------------------------------------------------------------------------
  // Static fetch
  // ---------------------------------------------------------------------------

  static override async fetchForAccount(account: Account): Promise<Array<Record<string, unknown>>> {
    const FEEDER_ROBOT_MODEL = getFeederRobotModel();
    const result = (await account.session.post(FEEDER_ENDPOINT, {
      json: { query: `query GetFeeders { feeder_unit ${FEEDER_ROBOT_MODEL} }` },
    })) as Record<string, unknown>;

    const robots = ((result["data"] as Record<string, unknown> | undefined)?.["feeder_unit"]) as unknown[];
    if (Array.isArray(robots)) {
      return robots.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null);
    }
    return [];
  }
}
