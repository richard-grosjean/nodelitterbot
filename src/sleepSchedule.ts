import { utcnow, todayAtTime } from "./utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minutesToTime(minutes: number): { hours: number; minutes: number } {
  return { hours: Math.floor(minutes / 60) % 24, minutes: minutes % 60 };
}

// ---------------------------------------------------------------------------
// DayOfWeek  (Sun=0 … Sat=6, matches Python impl)
// ---------------------------------------------------------------------------

export enum DayOfWeek {
  SUNDAY = 0,
  MONDAY = 1,
  TUESDAY = 2,
  WEDNESDAY = 3,
  THURSDAY = 4,
  FRIDAY = 5,
  SATURDAY = 6,
}

const DAY_NAMES: Record<string, DayOfWeek> = {
  SUNDAY: DayOfWeek.SUNDAY,
  MONDAY: DayOfWeek.MONDAY,
  TUESDAY: DayOfWeek.TUESDAY,
  WEDNESDAY: DayOfWeek.WEDNESDAY,
  THURSDAY: DayOfWeek.THURSDAY,
  FRIDAY: DayOfWeek.FRIDAY,
  SATURDAY: DayOfWeek.SATURDAY,
};

export function dayOfWeekFromName(name: string): DayOfWeek {
  const v = DAY_NAMES[name.toUpperCase()];
  if (v === undefined) throw new Error(`Unknown day name: ${name}`);
  return v;
}

/** Convert from JS Date.getDay() (Sun=0) to DayOfWeek — they already match. */
export function dayOfWeekFromDate(dt: Date): DayOfWeek {
  return dt.getDay() as DayOfWeek;
}

// ---------------------------------------------------------------------------
// SleepScheduleDay
// ---------------------------------------------------------------------------

export interface SleepScheduleDay {
  day: DayOfWeek;
  /** Hours/minutes of sleep start */
  sleepTime: { hours: number; minutes: number };
  /** Hours/minutes of wake */
  wakeTime: { hours: number; minutes: number };
  isEnabled: boolean;
}

function sleepScheduleDayFromNamedDict(name: string, data: Record<string, unknown>): SleepScheduleDay {
  return {
    day: dayOfWeekFromName(name),
    sleepTime: minutesToTime(data["sleepTime"] as number),
    wakeTime: minutesToTime(data["wakeTime"] as number),
    isEnabled: Boolean(data["isEnabled"]),
  };
}

function sleepScheduleDayFromIndexedDict(data: Record<string, unknown>): SleepScheduleDay {
  return {
    day: data["dayOfWeek"] as DayOfWeek,
    sleepTime: minutesToTime(data["sleepTime"] as number),
    wakeTime: minutesToTime(data["wakeTime"] as number),
    isEnabled: Boolean(data["isEnabled"]),
  };
}

// ---------------------------------------------------------------------------
// SleepSchedule
// ---------------------------------------------------------------------------

export class SleepSchedule {
  private _cachedWindow: [Date, Date] | null = null;

  constructor(public readonly days: SleepScheduleDay[]) {}

  get isEnabled(): boolean {
    return this.days.some((d) => d.isEnabled);
  }

  static parse(raw: Record<string, unknown> | Array<Record<string, unknown>>): SleepSchedule {
    let days: SleepScheduleDay[];
    if (Array.isArray(raw)) {
      days = raw.map(sleepScheduleDayFromIndexedDict);
    } else {
      days = Object.entries(raw).map(([name, data]) =>
        sleepScheduleDayFromNamedDict(name, data as Record<string, unknown>),
      );
    }
    return new SleepSchedule(days.sort((a, b) => a.day - b.day));
  }

  static fromTimestamp(
    sleepModeTime: number,
    duration: number /* ms */,
    isEnabled = true,
  ): SleepSchedule | null {
    if (!sleepModeTime) return null;

    const sleepStart = new Date(sleepModeTime * 1000);
    const sleepMinutes = sleepStart.getUTCHours() * 60 + sleepStart.getUTCMinutes();
    const durationMinutes = Math.floor(duration / 60_000);
    const wakeMinutes = (sleepMinutes + durationMinutes) % 1440;

    const days: SleepScheduleDay[] = Array.from({ length: 7 }, (_, i) => ({
      day: i as DayOfWeek,
      sleepTime: minutesToTime(sleepMinutes),
      wakeTime: minutesToTime(wakeMinutes),
      isEnabled,
    }));

    return new SleepSchedule(days);
  }

  getDay(day: DayOfWeek): SleepScheduleDay | undefined {
    return this.days.find((d) => d.day === day);
  }

  getWindow(dt?: Date): [Date, Date] | null {
    if (!this.isEnabled) return null;

    const now = dt ?? utcnow();

    // Use cached if still valid
    if (this._cachedWindow && Math.max(...this._cachedWindow.map((d) => d.getTime())) > now.getTime()) {
      return this._cachedWindow;
    }

    let start: Date | null = null;
    let end: Date | null = null;

    for (let offset = -7; offset <= 7; offset++) {
      const day = new Date(now.getTime() + offset * 86_400_000);
      const entry = this.getDay(dayOfWeekFromDate(day));
      if (!entry?.isEnabled) continue;

      const sleepM = entry.sleepTime.hours * 60 + entry.sleepTime.minutes;
      const wakeM = entry.wakeTime.hours * 60 + entry.wakeTime.minutes;

      const startOfDay = new Date(
        Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()),
      );

      let candidateStart: Date;
      if (wakeM < sleepM) {
        // Crosses midnight — sleep started the previous day
        candidateStart = new Date(startOfDay.getTime() - (1440 - sleepM) * 60_000);
      } else {
        candidateStart = new Date(startOfDay.getTime() + sleepM * 60_000);
      }

      const candidateEnd = new Date(startOfDay.getTime() + wakeM * 60_000);

      if (now.getTime() >= candidateStart.getTime() || end === null) {
        end = candidateEnd;
      }
      start = candidateStart;

      if (now.getTime() > Math.max(candidateStart.getTime(), candidateEnd.getTime())) {
        continue;
      }
      break;
    }

    if (!start || !end) {
      this._cachedWindow = null;
      return null;
    }

    this._cachedWindow = [start, end];
    return this._cachedWindow;
  }

  isActive(dt?: Date): boolean {
    const window = this.getWindow(dt);
    if (!window) return false;
    const now = dt ?? utcnow();
    return now >= window[0] && now < window[1];
  }
}
