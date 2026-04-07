import type { Account } from "../account.js";
import type { Activity, Insight } from "../activity.js";
import { LitterBoxCommand, type LitterBoxStatusEntry, LitterBoxStatus } from "../enums.js";
import { InvalidCommandException } from "../exceptions.js";
import { SleepSchedule } from "../sleepSchedule.js";
import { toTimestamp } from "../utils.js";
import { Robot } from "./index.js";

export const MINIMUM_CYCLES_LEFT_DEFAULT = 3;

// ---------------------------------------------------------------------------
// LitterRobot — abstract base for all Litter-Robot models
// ---------------------------------------------------------------------------

export abstract class LitterRobot extends Robot {
  protected override readonly _dataId: string = "litterRobotId";
  protected override readonly _dataName: string = "litterRobotNickname";
  protected override readonly _dataSerial: string = "litterRobotSerial";
  protected override readonly _dataSetupDate: string = "setupDate";
  protected override readonly _path: string = "";

  static readonly VALID_WAIT_TIMES: number[] = [3, 7, 15];

  protected _dataCycleCapacity = "cycleCapacity";
  protected _dataCycleCapacityDefault = 30;
  protected _dataCycleCount = "cycleCount";
  protected _dataDrawerFullCycles = "cyclesAfterDrawerFull";
  protected _dataPowerStatus = "powerStatus";

  protected _commandClean: string = LitterBoxCommand.CLEAN;
  protected _commandNightLightOff: string = LitterBoxCommand.NIGHT_LIGHT_OFF;
  protected _commandNightLightOn: string = LitterBoxCommand.NIGHT_LIGHT_ON;
  protected _commandPanelLockOff: string = LitterBoxCommand.LOCK_OFF;
  protected _commandPanelLockOn: string = LitterBoxCommand.LOCK_ON;
  protected _commandPowerOff: string = LitterBoxCommand.POWER_OFF;
  protected _commandPowerOn: string = LitterBoxCommand.POWER_ON;

  protected _minimumCyclesLeft = MINIMUM_CYCLES_LEFT_DEFAULT;
  protected _sleepSchedule: SleepSchedule | null = null;

  // ---------------------------------------------------------------------------
  // Abstract properties
  // ---------------------------------------------------------------------------

  abstract get cleanCycleWaitTimeMinutes(): number;
  abstract get isDrawerFullIndicatorTriggered(): boolean;
  abstract get isSleeping(): boolean;
  abstract get isWasteDrawerFull(): boolean;
  abstract get status(): LitterBoxStatusEntry;
  abstract get statusCode(): string | null;
  abstract get wasteDrawerLevel(): number;

  // ---------------------------------------------------------------------------
  // Abstract methods
  // ---------------------------------------------------------------------------

  protected abstract _dispatchCommand(command: string, ...args: unknown[]): Promise<boolean>;
  protected abstract _parseSleepInfo(): void;
  abstract getActivityHistory(limit?: number): Promise<Activity[]>;
  abstract getInsight(days?: number, timezoneOffset?: number | null): Promise<Insight>;

  // ---------------------------------------------------------------------------
  // Concrete properties
  // ---------------------------------------------------------------------------

  get cycleCapacity(): number {
    return Number(this._data[this._dataCycleCapacity] ?? this._dataCycleCapacityDefault);
  }

  get cycleCount(): number {
    return Number(this._data[this._dataCycleCount] ?? 0);
  }

  get cyclesAfterDrawerFull(): number {
    return Number(this._data[this._dataDrawerFullCycles] ?? 0);
  }

  override get isOnboarded(): boolean {
    return this._data["isOnboarded"] === true;
  }

  get lastSeen(): Date | null {
    return toTimestamp(this._data["lastSeen"] as string | undefined);
  }

  override get powerStatus(): string {
    return String(this._data[this._dataPowerStatus] ?? "NC");
  }

  get sleepModeEnabled(): boolean {
    return this._sleepSchedule?.isEnabled ?? false;
  }

  get sleepSchedule(): SleepSchedule | null {
    return this._sleepSchedule;
  }

  get sleepModeStartTime(): Date | null {
    const window = this._getSleepWindow();
    return window?.[0] ?? null;
  }

  get sleepModeEndTime(): Date | null {
    const window = this._getSleepWindow();
    return window?.[1] ?? null;
  }

  protected _getSleepWindow(): [Date, Date] | null {
    return this._sleepSchedule?.getWindow() ?? null;
  }

  get statusText(): string | null {
    return this.status.text;
  }

  // ---------------------------------------------------------------------------
  // Data update override — triggers sleep parsing
  // ---------------------------------------------------------------------------

  override _updateData(
    data: Record<string, unknown>,
    partial = false,
    callback?: () => void,
  ): void {
    const cb = () => {
      callback?.();
      this._parseSleepInfo();
      this._updateMinimumCyclesLeft();
    };
    super._updateData(data, partial, cb);
  }

  protected _updateMinimumCyclesLeft(): void {
    if (
      this.status === LitterBoxStatus.READY ||
      this._minimumCyclesLeft > this.status.minimumCyclesLeft
    ) {
      this._minimumCyclesLeft = this.status.minimumCyclesLeft;
    }
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async startCleaning(): Promise<boolean> {
    return this._dispatchCommand(this._commandClean);
  }

  async resetSettings(): Promise<boolean> {
    throw new InvalidCommandException("resetSettings() not implemented for this robot");
  }

  override async setNightLight(value: boolean): Promise<boolean> {
    return this._dispatchCommand(value ? this._commandNightLightOn : this._commandNightLightOff);
  }

  override async setPanelLockout(value: boolean): Promise<boolean> {
    return this._dispatchCommand(value ? this._commandPanelLockOn : this._commandPanelLockOff);
  }

  async setPowerStatus(value: boolean): Promise<boolean> {
    return this._dispatchCommand(value ? this._commandPowerOn : this._commandPowerOff);
  }

  async setWaitTime(waitTime: number): Promise<boolean> {
    throw new InvalidCommandException(`setWaitTime() not implemented for ${this.constructor.name}`);
  }

  async setSleepMode(value: boolean, sleepTime?: Date | null): Promise<boolean> {
    throw new InvalidCommandException(`setSleepMode() not implemented for ${this.constructor.name}`);
  }
}
