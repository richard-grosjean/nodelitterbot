import { LitterRobotEvent, EVENT_UPDATE } from "./event.js";
import { InvalidCommandException } from "./exceptions.js";
import type { Session } from "./session.js";
import { toTimestamp, dig } from "./utils.js";

// ---------------------------------------------------------------------------
// GraphQL model
// ---------------------------------------------------------------------------

const PET_MODEL = `
{
    petId
    userId
    createdAt
    name
    type
    gender
    weight
    weightLastUpdated
    lastWeightReading
    breeds
    age
    birthday
    adoptionDate
    s3ImageURL
    diet
    isFixed
    environmentType
    healthConcerns
    isHealthy
    isActive
    whiskerProducts
    petTagAssigned {
        petTag {
            petTagId
        }
    }
    weightIdFeatureEnabled
    weightHistory {
        weight
        timestamp
    }
    weightHistoryErrorType
}
`;

const PET_PROFILE_ENDPOINT = "https://pet-profile.iothings.site/graphql/";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum PetDiet {
  WET = "WET_FOOD",
  DRY = "DRY_FOOD",
  BOTH = "BOTH",
}

export enum PetEnvironment {
  INDOOR = "INDOOR",
  OUTDOOR = "OUTDOOR",
  BOTH = "BOTH",
}

export enum PetGender {
  FEMALE = "FEMALE",
  MALE = "MALE",
}

export enum PetType {
  CAT = "CAT",
  DOG = "DOG",
}

// ---------------------------------------------------------------------------
// WeightMeasurement
// ---------------------------------------------------------------------------

export interface WeightMeasurement {
  timestamp: Date;
  weight: number;
}

export function parseWeightHistory(
  weightData: Array<Record<string, unknown>> | null | undefined,
): WeightMeasurement[] {
  if (!weightData) return [];
  return weightData
    .flatMap((entry) => {
      const ts = toTimestamp(entry["timestamp"] as string | undefined);
      if (!ts) return [];
      return [{ timestamp: ts, weight: entry["weight"] as number }];
    });
}

// ---------------------------------------------------------------------------
// Pet
// ---------------------------------------------------------------------------

export class Pet extends LitterRobotEvent {
  private _data: Record<string, unknown>;
  private _session: Session;
  private _weightHistory: WeightMeasurement[];

  constructor(data: Record<string, unknown>, session: Session) {
    super();
    this._data = { ...data };
    this._session = session;
    this._weightHistory = parseWeightHistory(data["weightHistory"] as Array<Record<string, unknown>> | undefined);
  }

  // ---------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------

  get id(): string {
    return String(this._data["petId"] ?? "");
  }

  get name(): string {
    return String(this._data["name"] ?? "");
  }

  get petType(): PetType | undefined {
    const t = this._data["type"] as string | undefined;
    return Object.values(PetType).includes(t as PetType) ? t as PetType : undefined;
  }

  get gender(): PetGender | undefined {
    const g = this._data["gender"] as string | undefined;
    return Object.values(PetGender).includes(g as PetGender) ? g as PetGender : undefined;
  }

  get estimatedWeight(): number {
    return Number(this._data["weight"] ?? 0);
  }

  get lastWeightReading(): number | null {
    const v = this._data["lastWeightReading"];
    return v != null ? Number(v) : null;
  }

  get weight(): number {
    return this.lastWeightReading ?? this.estimatedWeight;
  }

  get breeds(): string[] | null {
    return (this._data["breeds"] as string[] | undefined) ?? null;
  }

  get age(): number | null {
    return (this._data["age"] as number | undefined) ?? null;
  }

  get birthday(): Date | null {
    const b = this._data["birthday"] as string | undefined;
    return b ? new Date(b) : null;
  }

  get adoptionDate(): Date | null {
    const a = this._data["adoptionDate"] as string | undefined;
    return a ? new Date(a) : null;
  }

  get diet(): PetDiet | undefined {
    const d = this._data["diet"] as string | undefined;
    return Object.values(PetDiet).includes(d as PetDiet) ? d as PetDiet : undefined;
  }

  get environmentType(): PetEnvironment | undefined {
    const e = this._data["environmentType"] as string | undefined;
    return Object.values(PetEnvironment).includes(e as PetEnvironment) ? e as PetEnvironment : undefined;
  }

  get healthConcerns(): string[] | null {
    return (this._data["healthConcerns"] as string[] | undefined) ?? null;
  }

  get imageUrl(): string | null {
    return (this._data["s3ImageURL"] as string | undefined) ?? null;
  }

  get isActive(): boolean {
    return Boolean(this._data["isActive"] ?? false);
  }

  get isFixed(): boolean {
    return Boolean(this._data["isFixed"] ?? false);
  }

  get isHealthy(): boolean {
    return Boolean(this._data["isHealthy"] ?? false);
  }

  get petTagId(): string | null {
    return (dig(this._data, "petTagAssigned.petTag.petTagId") as string | undefined) ?? null;
  }

  get weightIdFeatureEnabled(): boolean {
    return Boolean(this._data["weightIdFeatureEnabled"] ?? false);
  }

  get weightHistory(): WeightMeasurement[] {
    return this._weightHistory;
  }

  toDict(): Record<string, unknown> {
    return { ...this._data };
  }

  override toString(): string {
    return `Name: ${this.name}, Gender: ${this.gender}, Type: ${this.petType}, Breed: ${this.breeds?.join(", ")}, id: ${this.id}`;
  }

  // ---------------------------------------------------------------------------
  // Queries / Actions
  // ---------------------------------------------------------------------------

  getVisitsSince(start: Date): number {
    return this.weightHistory.filter((e) => e.timestamp >= start).length;
  }

  async fetchWeightHistory(limit = 50): Promise<WeightMeasurement[]> {
    const data = await Pet.queryWeightHistory(this._session, this.id, limit);
    this._weightHistory = parseWeightHistory(data);
    return this._weightHistory;
  }

  async refresh(): Promise<void> {
    const data = await Pet.queryById(this._session, this.id);
    if (data) this._updateData(data);
  }

  _updateData(data: Record<string, unknown>, partial = false): void {
    if (partial) {
      Object.assign(this._data, data);
    } else {
      this._data = { ...data };
    }
    if (data["weightHistory"]) {
      this._weightHistory = parseWeightHistory(data["weightHistory"] as Array<Record<string, unknown>>);
    }
    this.emit(EVENT_UPDATE);
  }

  // ---------------------------------------------------------------------------
  // Static factories
  // ---------------------------------------------------------------------------

  static async fetchPetsForUser(session: Session, userId: string): Promise<Pet[]> {
    const data = await Pet.queryByUser(session, userId);
    return data.map((d) => new Pet(d, session));
  }

  static async fetchPetById(session: Session, petId: string): Promise<Pet | null> {
    const data = await Pet.queryById(session, petId);
    return data ? new Pet(data, session) : null;
  }

  static async queryByUser(session: Session, userId: string): Promise<Array<Record<string, unknown>>> {
    const query = `query GetPetsByUser($userId: String!) { getPetsByUser(userId: $userId) ${PET_MODEL} }`;
    const res = (await Pet.queryGraphqlApi(session, query, { userId })) as Record<string, unknown>;
    return ((dig(res, "data.getPetsByUser") as Array<Record<string, unknown>> | undefined) ?? []);
  }

  static async queryById(session: Session, petId: string): Promise<Record<string, unknown> | null> {
    const query = `query GetPetByPetId($petId: String!) { getPetByPetId(petId: $petId) ${PET_MODEL} }`;
    const res = (await Pet.queryGraphqlApi(session, query, { petId })) as Record<string, unknown>;
    return (dig(res, "data.getPetByPetId") as Record<string, unknown> | undefined) ?? null;
  }

  static async queryWeightHistory(
    session: Session,
    petId: string,
    limit = 50,
  ): Promise<Array<Record<string, unknown>>> {
    if (limit < 1) throw new InvalidCommandException(`Invalid limit: ${limit}`);
    const query = `
      query GetWeightHistoryByPetId($petId: String!, $limit: Int) {
        getWeightHistoryByPetId(petId: $petId, limit: $limit) { weight timestamp }
      }
    `;
    const res = (await Pet.queryGraphqlApi(session, query, { petId, limit })) as Record<string, unknown>;
    return (dig(res, "data.getWeightHistoryByPetId") as Array<Record<string, unknown>> | undefined) ?? [];
  }

  static async queryGraphqlApi(
    session: Session,
    query: string,
    variables?: Record<string, unknown>,
    endpoint = PET_PROFILE_ENDPOINT,
  ): Promise<unknown> {
    return session.post(endpoint, { json: { query, variables } });
  }
}
