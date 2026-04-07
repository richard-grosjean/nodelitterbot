import { type LitterBoxStatusEntry, LitterBoxStatus } from "./enums.js";
import { pluralize } from "./utils.js";

export class Activity {
  constructor(
    public readonly timestamp: Date,
    public readonly action: LitterBoxStatusEntry | string,
  ) {}

  toString(): string {
    const actionStr =
      typeof this.action === "string"
        ? this.action
        : (this.action.text ?? String(this.action.value));
    return `${this.timestamp.toISOString()}: ${actionStr}`;
  }
}

export class Insight {
  constructor(
    public readonly totalCycles: number,
    public readonly averageCycles: number,
    public readonly cycleHistory: Array<[Date, number]>,
  ) {}

  get totalDays(): number {
    return this.cycleHistory.length;
  }

  toString(): string {
    return (
      `Completed ${pluralize("cycle", this.totalCycles)} averaging ` +
      `${this.averageCycles} cycles per day over the last ${pluralize("day", this.totalDays)}`
    );
  }
}

// Alias for compatibility
export { LitterBoxStatus };
