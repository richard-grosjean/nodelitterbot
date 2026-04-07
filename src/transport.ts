import { utcnow } from "./utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Forward-declare Robot to avoid circular imports
export interface RobotLike {
  readonly id: string;
  readonly name: string;
  readonly serial: string;
  readonly _account: import("./account.js").Account;
  refresh(): Promise<void>;
}

export interface WebSocketConfig {
  url: string;
  headers?: Record<string, string>;
  connectionInit?: Record<string, unknown>;
}

export interface WebSocketProtocol<T extends RobotLike = RobotLike> {
  wsConfigFactory: (robot: T) => Promise<WebSocketConfig>;
  subscribeFactory?: (robot: T, ws: WebSocket) => Promise<void>;
  unsubscribeFactory?: (robot: T, ws: WebSocket) => Promise<void>;
  messageHandler?: (robot: T, data: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Abstract Transport
// ---------------------------------------------------------------------------

export abstract class Transport {
  protected _lastReceived: Date | null = null;

  abstract start(robot: RobotLike): Promise<void>;
  abstract stop(robot: RobotLike): Promise<void>;
}

// ---------------------------------------------------------------------------
// WebSocketMonitor — shared WebSocket per robot class
// ---------------------------------------------------------------------------

const BACKOFF_MAX_MS = 300_000;

export class WebSocketMonitor<T extends RobotLike = RobotLike> extends Transport {
  private readonly _protocol: WebSocketProtocol<T>;
  private readonly _reconnectBaseMs: number;
  private _listeners = new Map<string, T>();
  private _ws: WebSocket | null = null;
  private _running = false;
  private _stopRequested = false;
  private _runLoopPromise: Promise<void> | null = null;

  constructor(protocol: WebSocketProtocol<T>, reconnectBaseMs = 1000) {
    super();
    this._protocol = protocol;
    this._reconnectBaseMs = reconnectBaseMs;
  }

  async start(robot: RobotLike): Promise<void> {
    const r = robot as T;
    this._listeners.set(r.id, r);

    if (!this._running) {
      this._stopRequested = false;
      this._running = true;
      this._runLoopPromise = this._runLoop();
    } else if (this._ws && this._protocol.subscribeFactory) {
      await this._protocol.subscribeFactory(r, this._ws);
    }
  }

  async stop(robot: RobotLike): Promise<void> {
    const r = robot as T;

    if (this._ws && this._protocol.unsubscribeFactory) {
      try {
        await this._protocol.unsubscribeFactory(r, this._ws);
      } catch {
        // ignore
      }
    }

    this._listeners.delete(r.id);

    if (this._listeners.size === 0) {
      this._stopRequested = true;
      this._ws?.close();
      if (this._runLoopPromise) {
        await this._runLoopPromise.catch(() => undefined);
        this._runLoopPromise = null;
      }
      this._running = false;
    }
  }

  private async _runLoop(): Promise<void> {
    let delay = this._reconnectBaseMs;
    while (!this._stopRequested) {
      try {
        await this._connect();
        delay = this._reconnectBaseMs;
      } catch (err) {
        if (this._stopRequested) break;
        console.warn(`WebSocket error; reconnecting in ${delay / 1000}s:`, err);
        await this._sleep(delay);
        delay = Math.min(delay * 2, BACKOFF_MAX_MS);
      }
    }
    this._running = false;
  }

  private async _connect(): Promise<void> {
    if (this._listeners.size === 0) return;

    const robot = [...this._listeners.values()][0]!;
    const config = await this._protocol.wsConfigFactory(robot);

    const ws = new WebSocket(config.url, undefined);

    // Apply custom headers — Node 24 native WebSocket supports second arg as options
    // Some environments need init headers; we store them on protocol config directly for
    // the url-based auth patterns used by LR3/LR4.

    this._ws = ws;

    if (config.connectionInit) {
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => {
          ws.send(JSON.stringify(config.connectionInit));
          resolve();
        }, { once: true });
        ws.addEventListener("error", (e) => reject(e), { once: true });
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", (e) => reject(e), { once: true });
      });
    }

    if (this._protocol.subscribeFactory) {
      for (const r of this._listeners.values()) {
        await this._protocol.subscribeFactory(r, ws);
      }
    }

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("message", (event) => {
        if (this._stopRequested) {
          ws.close();
          resolve();
          return;
        }
        this._lastReceived = utcnow();
        if (this._protocol.messageHandler) {
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(event.data as string) as Record<string, unknown>;
          } catch {
            return;
          }
          for (const r of this._listeners.values()) {
            try {
              this._protocol.messageHandler(r, data);
            } catch (err) {
              console.error(`Error dispatching WS message to robot ${r.id}:`, err);
            }
          }
        }
      });

      ws.addEventListener("close", () => resolve());
      ws.addEventListener("error", (e) => reject(e));
    });

    this._ws = null;
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// PollingTransport — per-robot REST polling
// ---------------------------------------------------------------------------

export class PollingTransport extends Transport {
  private readonly _intervalMs: number;
  private _stopRequested = false;
  private _runPromise: Promise<void> | null = null;

  constructor(intervalSeconds = 30) {
    super();
    this._intervalMs = intervalSeconds * 1000;
  }

  async start(robot: RobotLike): Promise<void> {
    if (this._runPromise) return;
    this._stopRequested = false;
    this._runPromise = this._runLoop(robot);
  }

  async stop(_robot: RobotLike): Promise<void> {
    this._stopRequested = true;
    if (this._runPromise) {
      await this._runPromise.catch(() => undefined);
      this._runPromise = null;
    }
  }

  private async _runLoop(robot: RobotLike): Promise<void> {
    let delay = this._intervalMs;
    while (!this._stopRequested) {
      try {
        await robot.refresh();
        this._lastReceived = utcnow();
        delay = this._intervalMs;
      } catch (err) {
        delay = Math.min(delay * 1.5, BACKOFF_MAX_MS);
        console.warn(
          `Polling refresh failed for ${robot.name}, retrying in ${delay / 1000}s:`,
          err,
        );
      }

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        // Abort the timer if stop is requested
        const check = setInterval(() => {
          if (this._stopRequested) {
            clearTimeout(timer);
            clearInterval(check);
            resolve();
          }
        }, 100);
        void Promise.resolve().then(() => {/* noop */});
        // cleanup interval when timer fires
        setTimeout(() => clearInterval(check), delay + 100);
      });
    }
  }
}
