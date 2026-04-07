import type { Account } from "../account.js";
import { LitterRobotEvent, EVENT_UPDATE } from "../event.js";
import type { Transport } from "../transport.js";
import { toTimestamp, urljoin } from "../utils.js";
import type { RequestOptions } from "../session.js";

// ---------------------------------------------------------------------------
// Robot base class
// ---------------------------------------------------------------------------

export abstract class Robot extends LitterRobotEvent {
  protected abstract readonly _dataId: string;
  protected abstract readonly _dataName: string;
  protected abstract readonly _dataSerial: string;
  protected abstract readonly _dataSetupDate: string;
  protected abstract readonly _path: string;

  protected _data: Record<string, unknown> = {};
  protected _isLoaded = false;
  protected _transport: Transport | null = null;
  protected _subscribed = false;

  readonly _account: Account;

  constructor(data: Record<string, unknown>, account: Account) {
    super();
    this._account = account;
    if (data) {
      this._updateData(data);
    }
  }

  protected _assertSerial(): void {
    if (this._data[this._dataSerial] == null) {
      throw new Error("Robot data must include a serial number");
    }
  }

  // ---------------------------------------------------------------------------
  // Abstract properties
  // ---------------------------------------------------------------------------

  abstract get isOnboarded(): boolean;
  abstract get isOnline(): boolean;
  abstract get nightLightModeEnabled(): boolean;
  abstract get panelLockEnabled(): boolean;
  abstract get powerStatus(): string;

  // ---------------------------------------------------------------------------
  // Abstract methods
  // ---------------------------------------------------------------------------

  abstract refresh(): Promise<void>;
  abstract setName(name: string): Promise<boolean>;
  abstract setNightLight(value: boolean): Promise<boolean>;
  abstract setPanelLockout(value: boolean): Promise<boolean>;

  // ---------------------------------------------------------------------------
  // Concrete properties
  // ---------------------------------------------------------------------------

  get id(): string {
    return String(this._data[this._dataId]);
  }

  abstract get model(): string;

  get name(): string {
    return String(this._data[this._dataName] ?? "");
  }

  get serial(): string {
    return String(this._data[this._dataSerial] ?? "");
  }

  get setupDate(): Date | null {
    return toTimestamp(this._data[this._dataSetupDate] as string | undefined);
  }

  get timezone(): string | null {
    return null;
  }

  // ---------------------------------------------------------------------------
  // Internal HTTP helpers
  // ---------------------------------------------------------------------------

  protected async _get(subpath?: string | null, options?: RequestOptions): Promise<unknown> {
    return this._account.session.get(urljoin(this._path, subpath), options);
  }

  protected async _post(subpath?: string | null, options?: RequestOptions): Promise<unknown> {
    return this._account.session.post(urljoin(this._path, subpath), options);
  }

  protected async _patch(subpath?: string | null, options?: RequestOptions): Promise<unknown> {
    return this._account.session.patch(urljoin(this._path, subpath), options);
  }

  // ---------------------------------------------------------------------------
  // Data update
  // ---------------------------------------------------------------------------

  _updateData(
    data: Record<string, unknown>,
    partial = false,
    callback?: () => void,
  ): void {
    if (this._isLoaded) {
      const merged = partial ? { ...this._data, ...data } : data;
      if (JSON.stringify(merged) !== JSON.stringify(this._data)) {
        // Data changed — could log details here
      }
    }

    if (partial) {
      Object.assign(this._data, data);
    } else {
      this._data = { ...data };
    }

    callback?.();
    this._isLoaded = true;
    this.emit(EVENT_UPDATE);
  }

  toDict(): Record<string, unknown> {
    return { ...this._data };
  }

  override toString(): string {
    return `Name: ${this.name}, Model: ${this.model}, Serial: ${this.serial}, id: ${this.id}`;
  }

  // ---------------------------------------------------------------------------
  // Subscribe / Unsubscribe
  // ---------------------------------------------------------------------------

  protected _buildTransport(): Transport {
    throw new Error(`${this.constructor.name} must implement _buildTransport()`);
  }

  async subscribe(): Promise<void> {
    if (this._subscribed) return;
    if (!this._transport) {
      this._transport = this._buildTransport();
    }
    await this._transport.start(this);
    this._subscribed = true;
  }

  async unsubscribe(): Promise<void> {
    if (this._transport) {
      await this._transport.stop(this);
      this._subscribed = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Static factory — override in subclasses
  // ---------------------------------------------------------------------------

  static async fetchForAccount(_account: Account): Promise<Array<Record<string, unknown>>> {
    throw new Error("fetchForAccount() not implemented");
  }
}
