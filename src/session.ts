import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserSession,
  CognitoRefreshToken,
} from "amazon-cognito-identity-js";
import { LitterRobotEvent, EVENT_UPDATE } from "./event.js";
import { InvalidCommandException, LitterRobotLoginException } from "./exceptions.js";
import { decode, decodeJwtPayload, redact, utcnow } from "./utils.js";

// ---------------------------------------------------------------------------
// Decoded Cognito constants
// ---------------------------------------------------------------------------

const USER_POOL_ID = decode("dXMtZWFzdC0xX3JqaE5uWlZBbQ=="); // us-east-1_rjhNnZVAm
const CLIENT_ID = decode("NDU1MnVqZXUzYWljOTBuZjhxbjUzbGV2bW4=");   // 4552ujeu3aic90nf8qn53levmn

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenSet {
  access_token: string;
  id_token: string;
  refresh_token?: string;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  params?: Record<string, string>;
  json?: unknown;
  skipAuth?: boolean;
}

// ---------------------------------------------------------------------------
// Abstract Session
// ---------------------------------------------------------------------------

export abstract class Session extends LitterRobotEvent {
  abstract get tokens(): TokenSet | null;
  abstract asyncGetIdToken(): Promise<string | null>;
  abstract isTokenValid(): boolean;
  abstract login(username: string, password: string): Promise<void>;
  protected abstract _refreshTokens(): Promise<void>;

  async getBearerAuthorization(): Promise<string | null> {
    const token = await this.asyncGetIdToken();
    if (!token) return null;
    return `Bearer ${token}`;
  }

  async refreshTokens(ignoreUnexpired = false): Promise<void> {
    if (!this.tokens) return;
    if (!ignoreUnexpired && this.isTokenValid()) return;
    await this._refreshTokens();
    this.emit(EVENT_UPDATE);
  }

  async get(url: string, options?: RequestOptions): Promise<unknown> {
    return this.request("GET", url, options);
  }

  async post(url: string, options?: RequestOptions): Promise<unknown> {
    return this.request("POST", url, options);
  }

  async patch(url: string, options?: RequestOptions): Promise<unknown> {
    return this.request("PATCH", url, options);
  }

  async request(method: string, url: string, options: RequestOptions = {}): Promise<unknown> {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...options.headers };

    if (!options.skipAuth) {
      const auth = await this.getBearerAuthorization();
      if (auth) headers["authorization"] = auth;
    }

    let fullUrl = url;
    if (options.params && Object.keys(options.params).length > 0) {
      const q = new URLSearchParams(options.params);
      fullUrl = `${url}?${q.toString()}`;
    }

    const init: RequestInit = {
      method,
      headers,
    };

    if (options.json !== undefined && method !== "GET") {
      init.body = JSON.stringify(options.json);
    }

    const resp = await fetch(fullUrl, init);

    if (resp.status === 500) {
      let body: Record<string, unknown> = {};
      try { body = await resp.json() as Record<string, unknown>; } catch { /* ignore */ }
      if (body["type"] === "InvalidCommandException") {
        throw new InvalidCommandException(String(body["developerMessage"] ?? body));
      }
      throw new InvalidCommandException(JSON.stringify(body));
    }

    if (!resp.ok) {
      throw new InvalidCommandException(`HTTP ${resp.status}: ${resp.statusText} — ${url}`);
    }

    const contentType = resp.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return resp.json();
    }
    return resp.text();
  }
}

// ---------------------------------------------------------------------------
// LitterRobotSession
// ---------------------------------------------------------------------------

export class LitterRobotSession extends Session {
  private _userPool: CognitoUserPool;
  private _cognitoUser: CognitoUser | null = null;
  private _session: CognitoUserSession | null = null;
  private _username: string | null = null;
  private _customArgs: Record<string, Record<string, unknown>> = {};

  // Pre-loaded token support
  private _accessToken: string | null;
  private _idToken: string | null;
  private _refreshToken: string | null;

  constructor(token?: TokenSet) {
    super();
    this._userPool = new CognitoUserPool({
      UserPoolId: USER_POOL_ID,
      ClientId: CLIENT_ID,
    });

    this._accessToken = token?.access_token ?? null;
    this._idToken = token?.id_token ?? null;
    this._refreshToken = token?.refresh_token ?? null;
  }

  get tokens(): TokenSet | null {
    const accessToken = this._session?.getAccessToken().getJwtToken() ?? this._accessToken;
    const idToken = this._session?.getIdToken().getJwtToken() ?? this._idToken;
    if (!accessToken || !idToken) return null;
    return {
      access_token: accessToken,
      id_token: idToken,
      ...(this._session?.getRefreshToken().getToken()
        ? { refresh_token: this._session.getRefreshToken().getToken() }
        : this._refreshToken
          ? { refresh_token: this._refreshToken }
          : {}),
    };
  }

  async asyncGetIdToken(): Promise<string | null> {
    if (!this.isTokenValid()) return null;
    return this._session?.getIdToken().getJwtToken() ?? this._idToken;
  }

  isTokenValid(): boolean {
    const idToken = this._session?.getIdToken().getJwtToken() ?? this._idToken;
    if (!idToken) return false;
    try {
      const payload = decodeJwtPayload(idToken);
      const exp = payload["exp"] as number | undefined;
      if (exp === undefined) return false;
      // Add 30s leeway
      return exp > utcnow().getTime() / 1000 + 30;
    } catch {
      return false;
    }
  }

  async login(username: string, password: string): Promise<void> {
    this._username = username;
    return new Promise((resolve, reject) => {
      const user = this._getOrCreateCognitoUser(username);
      const authDetails = new AuthenticationDetails({ Username: username, Password: password });

      user.authenticateUser(authDetails, {
        onSuccess: (session) => {
          this._session = session;
          this.emit(EVENT_UPDATE);
          resolve();
        },
        onFailure: (err: Error) => {
          reject(new LitterRobotLoginException(err.message));
        },
      });
    });
  }

  protected async _refreshTokens(): Promise<void> {
    const refreshTokenStr =
      this._session?.getRefreshToken().getToken() ?? this._refreshToken;

    if (!refreshTokenStr) throw new Error("No refresh token available");

    const user = this._getOrCreateCognitoUser(this._username ?? "");
    const token = new CognitoRefreshToken({ RefreshToken: refreshTokenStr });

    return new Promise((resolve, reject) => {
      user.refreshSession(token, (err, session) => {
        if (err) {
          reject(err);
        } else {
          this._session = session as CognitoUserSession;
          resolve();
        }
      });
    });
  }

  hasRefreshToken(): boolean {
    return Boolean(
      this._session?.getRefreshToken().getToken() || this._refreshToken,
    );
  }

  getUserId(): string | null {
    const idToken = this._session?.getIdToken().getJwtToken() ?? this._idToken;
    if (!idToken) return null;
    try {
      const payload = decodeJwtPayload(idToken);
      return (payload["mid"] as string | undefined) ?? null;
    } catch {
      return null;
    }
  }

  /** Inject custom headers/params for a given URL prefix. */
  setCustomArgs(urlPrefix: string, args: Record<string, unknown>): void {
    this._customArgs[urlPrefix] = args;
  }

  override async request(method: string, url: string, options: RequestOptions = {}): Promise<unknown> {
    // Merge custom args for matching URL prefixes
    for (const [prefix, extra] of Object.entries(this._customArgs)) {
      if (url.startsWith(prefix)) {
        if (extra["headers"] && typeof extra["headers"] === "object") {
          options = {
            ...options,
            headers: { ...(extra["headers"] as Record<string, string>), ...(options.headers ?? {}) },
          };
        }
      }
    }

    if (!options.skipAuth && !this.isTokenValid()) {
      await this.refreshTokens();
    }

    return super.request(method, url, options);
  }

  private _getOrCreateCognitoUser(username: string): CognitoUser {
    if (!this._cognitoUser || this._cognitoUser.getUsername() !== username) {
      this._cognitoUser = new CognitoUser({ Username: username, Pool: this._userPool });
    }
    return this._cognitoUser;
  }
}
