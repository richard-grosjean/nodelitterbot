// ---------------------------------------------------------------------------
// nodelitterbot — TypeScript/Node.js port of pylitterbot
// Unofficial API for Whisker Litter-Robot and Feeder-Robot devices
// ---------------------------------------------------------------------------

// Main entry point
export { Account } from "./account.js";
export type { AccountOptions, ConnectOptions } from "./account.js";

// Robots
export { Robot } from "./robot/index.js";
export { LitterRobot } from "./robot/litterrobot.js";
export { LitterRobot3 } from "./robot/litterrobot3.js";
export { LitterRobot4 } from "./robot/litterrobot4.js";
export { LitterRobot5 } from "./robot/litterrobot5.js";
export { FeederRobot } from "./robot/feederrobot.js";

// Pet
export { Pet, PetType, PetGender, PetDiet, PetEnvironment } from "./pet.js";
export type { WeightMeasurement } from "./pet.js";

// Session
export { LitterRobotSession } from "./session.js";
export type { TokenSet } from "./session.js";

// Enums
export {
  FeederRobotCommand,
  LitterBoxCommand,
  LitterRobot4Command,
  LitterRobot5Command,
  LitterBoxStatus,
  lbStatusFromValue,
  getDrawerFullStatuses,
  BrightnessLevel,
  GlobeMotorFaultStatus,
  globeMotorFaultFromRaw,
  HopperStatus,
  LitterLevelState,
  NightLightMode,
} from "./enums.js";
export type { LitterBoxStatusEntry } from "./enums.js";

// Exceptions
export {
  LitterRobotException,
  LitterRobotLoginException,
  InvalidCommandException,
} from "./exceptions.js";

// Activity / Insight
export { Activity, Insight } from "./activity.js";

// Sleep schedule
export { SleepSchedule, SleepScheduleDay, DayOfWeek } from "./sleepSchedule.js";
export type { SleepScheduleDay as SleepScheduleDayType } from "./sleepSchedule.js";

// Events
export { LitterRobotEvent, EVENT_UPDATE } from "./event.js";

// Transport (advanced use)
export { WebSocketMonitor, PollingTransport } from "./transport.js";
export type { WebSocketProtocol, RobotLike } from "./transport.js";

// Utilities (exported for consumers who need them)
export { decode, encode, toTimestamp, urljoin, utcnow, redact, dig } from "./utils.js";
