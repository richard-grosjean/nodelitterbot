import { LitterRobotLoginException, LitterRobotException } from "./exceptions.js";
import { Pet } from "./pet.js";
import { Robot } from "./robot/index.js";
import { LitterRobot3, DEFAULT_ENDPOINT, DEFAULT_ENDPOINT_KEY } from "./robot/litterrobot3.js";
import { LitterRobot4 } from "./robot/litterrobot4.js";
import { LitterRobot5 } from "./robot/litterrobot5.js";
import { FeederRobot } from "./robot/feederrobot.js";
import { LitterRobotSession, type TokenSet } from "./session.js";
import { decode, urljoin } from "./utils.js";
import type { WebSocketProtocol, RobotLike } from "./transport.js";
import { WebSocketMonitor } from "./transport.js";

export interface AccountOptions {
  token?: TokenSet;
  tokenUpdateCallback?: (token: TokenSet | null) => void;
}

export interface ConnectOptions {
  username?: string;
  password?: string;
  loadRobots?: boolean;
  subscribeForUpdates?: boolean;
  loadPets?: boolean;
}

type RobotClass = {
  name: string;
  fetchForAccount(account: Account): Promise<Array<Record<string, unknown>>>;
  new(data: Record<string, unknown>, account: Account): Robot;
  readonly prototype: {
    readonly _dataSerial: string;
    readonly _dataId: string;
    readonly _dataName: string;
  };
};

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export class Account {
  private _session: LitterRobotSession;
  private _userId: string | null;
  private _user: Record<string, unknown> = {};
  private _robots: Robot[] = [];
  private _pets: Pet[] = [];
  private _monitors = new Map<Function, WebSocketMonitor<RobotLike>>();

  constructor(options: AccountOptions = {}) {
    this._session = new LitterRobotSession(options.token);

    // Inject LR3 API key
    this._session.setCustomArgs(DEFAULT_ENDPOINT, {
      headers: { "x-api-key": decode(DEFAULT_ENDPOINT_KEY) },
    });

    this._userId = options.token ? this._session.getUserId() : null;

    if (options.tokenUpdateCallback) {
      this._session.on("update", () => {
        options.tokenUpdateCallback!(this._session.tokens);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------

  get userId(): string | null {
    if (!this._userId && this._session) {
      this._userId = this._session.getUserId();
    }
    return this._userId;
  }

  get robots(): Robot[] {
    return this._robots;
  }

  get pets(): Pet[] {
    return this._pets;
  }

  get session(): LitterRobotSession {
    return this._session;
  }

  // ---------------------------------------------------------------------------
  // Robot lookup
  // ---------------------------------------------------------------------------

  getRobot(robotId: string | number | null): Robot | undefined {
    if (robotId == null) return undefined;
    return this._robots.find((r) => r.id === String(robotId));
  }

  getRobots<T extends Robot>(
    robotClass: new (...args: unknown[]) => T,
    ignoreRemoved = false,
  ): T[] {
    return this._robots.filter(
      (r): r is T => r instanceof robotClass && (ignoreRemoved || r.isOnboarded),
    );
  }

  getPet(petId: string): Pet | undefined {
    return this._pets.find((p) => p.id === petId);
  }

  // ---------------------------------------------------------------------------
  // Connect / Disconnect
  // ---------------------------------------------------------------------------

  async connect(options: ConnectOptions = {}): Promise<void> {
    try {
      if (!this._session.isTokenValid()) {
        if (this._session.hasRefreshToken()) {
          await this._session.refreshTokens();
        } else if (options.username && options.password) {
          await this._session.login(options.username, options.password);
        } else {
          throw new LitterRobotLoginException("Username and password are required to login.");
        }
      }

      // Capture user ID now that we're authenticated
      this._userId = this._session.getUserId();

      if (options.loadRobots) {
        await this.loadRobots(options.subscribeForUpdates ?? false);
      }

      if (options.loadPets) {
        await this.loadPets();
      }
    } catch (err) {
      if (err instanceof LitterRobotLoginException) throw err;
      if (err instanceof Error) {
        throw new LitterRobotException(`Unable to connect to Litter-Robot: ${err.message}`);
      }
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    const unsubscribePromises = this._robots.map((r) =>
      r.unsubscribe().catch((err) => console.warn("Error during unsubscribe:", err)),
    );
    await Promise.all(unsubscribePromises);
    this._monitors.clear();
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  async refreshUser(): Promise<void> {
    const data = (await this._session.get(
      urljoin(DEFAULT_ENDPOINT, `users/${this.userId}`),
    )) as Record<string, unknown>;
    Object.assign(this._user, (data["user"] as Record<string, unknown>) ?? {});
  }

  async loadPets(): Promise<void> {
    if (!this.userId) throw new Error("userId not available — connect first");
    const pets = await Pet.fetchPetsForUser(this._session, this.userId);
    if (!this._pets.length) {
      this._pets = pets;
    } else {
      for (const pet of pets) {
        const existing = this.getPet(pet.id);
        if (existing) {
          existing._updateData(pet.toDict());
        } else {
          this._pets.push(pet);
        }
      }
    }
  }

  async loadRobots(subscribeForUpdates = false): Promise<void> {
    const robotClasses: RobotClass[] = [
      LitterRobot3 as unknown as RobotClass,
      LitterRobot4 as unknown as RobotClass,
      LitterRobot5 as unknown as RobotClass,
      FeederRobot as unknown as RobotClass,
    ];

    const robots: Robot[] = [];

    const results = await Promise.allSettled(
      robotClasses.map((cls) => cls.fetchForAccount(this)),
    );

    for (let i = 0; i < robotClasses.length; i++) {
      const robotClass = robotClasses[i]!;
      const result = results[i]!;

      if (result.status === "rejected") {
        console.error(`Failed to fetch ${robotClass.name}:`, result.reason);
        // Preserve previously-known robots of this type
        for (const existing of this._robots) {
          if (existing instanceof robotClass) robots.push(existing);
        }
        continue;
      }

      for (const robotData of result.value) {
        // Skip robots without a serial
        const proto = robotClass.prototype as { _dataSerial?: string; _dataId?: string; _dataName?: string };
        const serialKey = proto._dataSerial ?? "serial";
        const idKey = proto._dataId ?? "id";
        const nameKey = proto._dataName ?? "name";

        if (robotData[serialKey] == null) {
          console.info(
            `Skipping robot without serial (id=${robotData[idKey]}, name=${robotData[nameKey]})`,
          );
          continue;
        }

        const existing = this.getRobot(robotData[idKey] as string);
        if (existing) {
          existing._updateData(robotData);
          if (subscribeForUpdates && !existing["_subscribed"]) {
            await existing.subscribe();
          }
          robots.push(existing);
        } else {
          try {
            const robot = new robotClass(robotData, this);
            if (subscribeForUpdates) {
              await robot.subscribe();
            }
            robots.push(robot);
          } catch (err) {
            console.error(`Failed to instantiate ${robotClass.name}:`, err);
          }
        }
      }
    }

    this._robots = robots;
  }

  async refreshRobots(): Promise<void> {
    await Promise.allSettled(
      this._robots.map((r) =>
        r.refresh().catch((err) => console.error("Failed to refresh robot:", err)),
      ),
    );
  }

  async getBearerAuthorization(): Promise<string> {
    if (!this._session.isTokenValid()) {
      await this._session.refreshTokens();
    }
    return (await this._session.getBearerAuthorization()) ?? "";
  }

  // ---------------------------------------------------------------------------
  // WebSocket monitor factory
  // ---------------------------------------------------------------------------

  getMonitorFor<T extends RobotLike>(
    robotClass: Function,
    protocol: WebSocketProtocol<T>,
  ): WebSocketMonitor<T> {
    if (!this._monitors.has(robotClass)) {
      this._monitors.set(robotClass, new WebSocketMonitor<T>(protocol) as unknown as WebSocketMonitor<RobotLike>);
    }
    return this._monitors.get(robotClass) as unknown as WebSocketMonitor<T>;
  }
}
