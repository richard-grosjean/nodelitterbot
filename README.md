# nodelitterbot

TypeScript/Node.js port of [pylitterbot](https://github.com/natekspencer/pylitterbot) — an unofficial client for Whisker's self-cleaning litter boxes and feeders.

Supports **Litter-Robot 3**, **Litter-Robot 4**, **Litter-Robot 5 / 5 Pro**, and **Feeder-Robot**, plus pet profiles.

> **Disclaimer** — This is an unofficial, reverse-engineered API. It has no affiliation with Whisker and may break at any time. Use at your own risk.

> **Caveat emptor** — This library was 100% vibe coded by an AI. It has not been audited, battle-tested, or verified against real hardware beyond basic smoke tests. There may be bugs, edge cases, or subtle API mismatches lurking. Review the code before trusting it with anything important, and don't blame the cat if something goes wrong.

---

## Requirements

- Node.js 24 or later (uses native `fetch` and `WebSocket`)
- A Whisker account with at least one registered device

---

## Installation

```bash
npm install nodelitterbot
```

---

## Quick start

```ts
import { Account } from "nodelitterbot";

const account = new Account();

try {
  await account.connect({
    username: "your@email.com",
    password: "yourpassword",
    loadRobots: true,
    loadPets: true,
  });

  for (const robot of account.robots) {
    console.log(String(robot));
    // Name: My LitterBot, Model: Litter-Robot 4, Serial: LR4C012345, id: a1b2c3
  }
} finally {
  await account.disconnect();
}
```

---

## Authentication

### Username + password (first-time)

```ts
const account = new Account();
await account.connect({ username: "...", password: "..." });
```

### Token reuse (avoid re-authenticating every run)

After a successful login the session holds a token set. Save it and pass it back on subsequent runs to skip the Cognito login round-trip.

```ts
import { Account, type TokenSet } from "nodelitterbot";
import { readFileSync, writeFileSync } from "node:fs";

function loadToken(): TokenSet | undefined {
  try {
    return JSON.parse(readFileSync("token.json", "utf8")) as TokenSet;
  } catch {
    return undefined;
  }
}

const account = new Account({
  token: loadToken(),
  // Called automatically whenever the token is refreshed
  tokenUpdateCallback: (token) => {
    if (token) {
      writeFileSync("token.json", JSON.stringify(token));
    }
  },
});

await account.connect({
  username: "your@email.com", // Only used if token is missing/expired
  password: "yourpassword",
  loadRobots: true,
});
```

The `TokenSet` contains `access_token`, `id_token`, and `refresh_token`. Tokens are refreshed automatically using the refresh token when they expire.

---

## Working with robots

### Listing robots

```ts
import { LitterRobot3, LitterRobot4, LitterRobot5, FeederRobot } from "nodelitterbot";

for (const robot of account.robots) {
  console.log(robot.name, robot.model, robot.serial);
  console.log("Online:", robot.isOnline);
  console.log("Status:", robot.status.text); // e.g. "Ready", "Clean Cycle In Progress"
}

// Filter by type
const lr4s = account.getRobots(LitterRobot4);
const feeders = account.getRobots(FeederRobot);
```

### Common properties (all robots)

| Property | Type | Description |
|---|---|---|
| `id` | `string` | Unique device ID |
| `name` | `string` | Device nickname |
| `model` | `string` | e.g. `"Litter-Robot 4"` |
| `serial` | `string` | Serial number |
| `isOnline` | `boolean` | Whether device is reachable |
| `isOnboarded` | `boolean` | Whether device is set up in the app |
| `setupDate` | `Date \| null` | Date the device was onboarded |
| `timezone` | `string \| null` | Device timezone string |
| `powerStatus` | `string` | `"AC"` mains, `"DC"` battery, `"NC"` unknown |
| `panelLockEnabled` | `boolean` | Whether buttons are locked |
| `nightLightModeEnabled` | `boolean` | Whether night light is on |

### Common methods (all robots)

```ts
await robot.refresh();                    // Fetch latest state from API
await robot.setName("My LitterBot");
await robot.setNightLight(true);
await robot.setPanelLockout(true);
robot.toDict();                           // Raw data object from API
```

---

## Litter-Robot (3, 4, 5)

All litter box robots share the `LitterRobot` base class with additional properties and methods beyond the common ones above.

### Status

```ts
import { LitterBoxStatus } from "nodelitterbot";

console.log(robot.status.value);          // "RDY", "CCP", "BR", etc.
console.log(robot.status.text);           // "Ready", "Clean Cycle In Progress", etc.
console.log(robot.statusCode);            // Same as status.value (or raw string for unknown)
console.log(robot.statusText);            // Convenience alias for status.text

// Well-known statuses
LitterBoxStatus.READY
LitterBoxStatus.CLEAN_CYCLE
LitterBoxStatus.CAT_DETECTED
LitterBoxStatus.DRAWER_FULL
LitterBoxStatus.OFFLINE
// ... see LitterBoxStatus for the full list
```

### Waste drawer

```ts
console.log(robot.wasteDrawerLevel);      // 0–100 (%)
console.log(robot.isWasteDrawerFull);     // boolean
console.log(robot.cycleCount);            // cycles since last reset
console.log(robot.cycleCapacity);         // estimated total capacity
console.log(robot.isDrawerFullIndicatorTriggered); // DFI sensor
```

### Cleaning

```ts
await robot.startCleaning();              // Trigger a clean cycle
await robot.setPowerStatus(true);         // Power on
await robot.setPowerStatus(false);        // Power off
await robot.setWaitTime(7);               // Minutes to wait after visit (3/7/15 for LR3; 3/7/15/25/30 for LR4+)
```

### Sleep mode

```ts
console.log(robot.sleepModeEnabled);      // boolean
console.log(robot.sleepModeStartTime);    // Date | null
console.log(robot.sleepModeEndTime);      // Date | null
console.log(robot.isSleeping);            // Currently in sleep window
console.log(robot.sleepSchedule);         // SleepSchedule object

// LR3 only — set a single daily sleep window
await (robot as LitterRobot3).setSleepMode(true, new Date("2026-01-01T22:00:00"));
await (robot as LitterRobot3).setSleepMode(false);
```

### Activity & insights

```ts
import { LitterRobot3, LitterRobot4 } from "nodelitterbot";

// Works on LR3 and LR4
const activities = await robot.getActivityHistory(50); // last 50 events
for (const a of activities) {
  console.log(a.timestamp, String(a.action));
}

const insight = await robot.getInsight(30); // last 30 days
console.log(`${insight.totalCycles} cycles over ${insight.totalDays} days`);
console.log(`Average: ${insight.averageCycles.toFixed(1)} cycles/day`);
```

---

## Litter-Robot 3 specific

```ts
import { LitterRobot3 } from "nodelitterbot";

const lr3 = account.getRobots(LitterRobot3)[0]!;

await lr3.resetSettings();                // Restore factory defaults
await lr3.resetWasteDrawer();             // Reset cycle counter after emptying

console.log(lr3.nightLightModeEnabled);   // boolean
console.log(lr3.panelLockEnabled);        // boolean
```

---

## Litter-Robot 4 specific

```ts
import { LitterRobot4, BrightnessLevel, NightLightMode } from "nodelitterbot";

const lr4 = account.getRobots(LitterRobot4)[0]!;

// Firmware
console.log(lr4.firmware);               // "ESP: 1.2.3 / PIC: 4.5.6 / TOF: 7.8.9"
await lr4.getFirmwareDetails();
console.log(await lr4.hasUpdate());
await lr4.updateFirmware();

// Night light
console.log(lr4.nightLightMode);         // NightLightMode.ON | OFF | AUTO
console.log(lr4.nightLightBrightness);   // 0–100
await lr4.setNightLightMode(NightLightMode.AUTO);
await lr4.setNightLightBrightness(BrightnessLevel.MEDIUM); // 25 | 50 | 100

// Panel brightness
console.log(lr4.panelBrightness);        // BrightnessLevel.LOW | MEDIUM | HIGH
await lr4.setPanelBrightness(BrightnessLevel.LOW);

// Litter level
console.log(lr4.litterLevel);            // % from API
console.log(lr4.litterLevelCalculated);  // % calculated from ToF sensor distance
console.log(lr4.litterLevelState);       // LitterLevelState.OPTIMAL | LOW | EMPTY | etc.

// LitterHopper accessory
console.log(lr4.hopperStatus);           // HopperStatus enum
await lr4.toggleHopper(true);            // disable/remove
await lr4.toggleHopper(false);           // enable/re-install

// Miscellaneous
console.log(lr4.petWeight);              // last recorded weight (lbs)
console.log(lr4.scoopsSavedCount);
console.log(lr4.globeMotorFaultStatus);  // GlobeMotorFaultStatus enum
await lr4.reset();                        // short reset press (clears errors)
```

---

## Litter-Robot 5 / 5 Pro specific

> LR5 uses polling rather than WebSocket — state is refreshed every 30 seconds automatically when subscribed.

```ts
import { LitterRobot5, BrightnessLevel, NightLightMode } from "nodelitterbot";

const lr5 = account.getRobots(LitterRobot5)[0]!;

console.log(lr5.model);                  // "Litter-Robot 5" or "Litter-Robot 5 Pro"
console.log(lr5.isPro);                  // boolean

// Litter & waste
console.log(lr5.litterLevel);            // % from state
console.log(lr5.wasteDrawerLevel);       // % from dfiLevelPercent
console.log(lr5.isWasteDrawerFull);
await lr5.resetWasteDrawer();
await lr5.changeFilter();                // Reset filter counter

// Night light (LR5 supports color)
await lr5.setNightLightSettings({ mode: NightLightMode.AUTO, brightness: 75, color: "#FF8800" });
await lr5.setNightLightMode(NightLightMode.ON);
await lr5.setNightLightBrightness(50);

// Panel
await lr5.setPanelBrightness(BrightnessLevel.LOW);
await lr5.setPanelLockout(true);

// Privacy mode (disables camera on Pro)
await lr5.setPrivacyMode(true);

// Sound (volume 0–100)
await lr5.setVolume(50);
await lr5.setCameraAudio(false);         // Pro only

// Sleep schedule (per-day, 0=Mon…6=Sun, times in minutes from midnight)
await lr5.setSleepMode(true, { sleepTime: 22 * 60, wakeTime: 7 * 60 });  // 10 PM–7 AM every day
await lr5.setSleepMode(true, { sleepTime: 23 * 60, wakeTime: 8 * 60, dayOfWeek: 5 }); // Saturday only
await lr5.setSleepMode(false);

// Activity (richer data than LR3/LR4)
const activities = await lr5.getActivities({ limit: 50, activityType: "PET_VISIT" });
// activityType options: "PET_VISIT" | "CYCLE_COMPLETED" | "CAT_DETECT" | "OFFLINE" | "LITTER_LOW"

// Reassign a pet visit to a different pet
await lr5.reassignPetVisit("eventId123", { fromPetId: "petA", toPetId: "petB" });

// Sensors & diagnostics
console.log(lr5.globeMotorFaultStatus);
console.log(lr5.isLaserDirty);
console.log(lr5.isBonnetRemoved);
console.log(lr5.isDrawerRemoved);
console.log(lr5.petWeight);              // lbs (converted from raw API integer)
console.log(lr5.wifiRssi);
console.log(lr5.firmware);
await lr5.reset();
```

---

## Feeder-Robot

```ts
import { FeederRobot } from "nodelitterbot";

const feeder = account.getRobots(FeederRobot)[0]!;

// State
console.log(feeder.isOnline);
console.log(feeder.foodLevel);           // 0–100 (%)
console.log(feeder.mealInsertSize);      // cups: 0.125 or 0.25
console.log(feeder.gravityModeEnabled);  // boolean
console.log(feeder.firmwareVersion);

// Feeding history
console.log(feeder.lastFeeding);         // { timestamp, amount, name }
console.log(feeder.lastMeal);
console.log(feeder.lastSnack);
console.log(feeder.nextFeeding);         // Date | null (next scheduled meal)
feeder.getFoodDispensedSince(new Date("2026-01-01")); // cups since date

// Commands
await feeder.giveSnack();
await feeder.setMealInsertSize(0.25);    // 0.125 (1/8 cup) or 0.25 (1/4 cup)
await feeder.setGravityMode(true);
await feeder.setNightLight(true);
await feeder.setPanelLockout(false);
await feeder.setName("Feeder Bot");
```

---

## Pet profiles

```ts
import { PetType, PetGender } from "nodelitterbot";

await account.loadPets();

for (const pet of account.pets) {
  console.log(pet.name);
  console.log(pet.petType);              // PetType.CAT | DOG
  console.log(pet.gender);              // PetGender.MALE | FEMALE
  console.log(pet.weight);              // lbs
  console.log(pet.breeds);              // string[] | null
  console.log(pet.age);
  console.log(pet.birthday);            // Date | null
  console.log(pet.adoptionDate);        // Date | null
  console.log(pet.diet);               // PetDiet.WET | DRY | BOTH
  console.log(pet.imageUrl);
  console.log(pet.isHealthy);
  console.log(pet.petTagId);            // RFID tag if assigned

  // Weight history
  const history = await pet.fetchWeightHistory(30); // last 30 readings
  for (const w of history) {
    console.log(w.timestamp, w.weight, "lbs");
  }

  // Visits since a date
  const visits = pet.getVisitsSince(new Date("2026-01-01"));
  console.log(`Visits this year: ${visits}`);
}
```

---

## Real-time updates (WebSocket / polling)

Subscribe to a robot to receive live state updates. LR3 and LR4 use WebSocket; LR5 uses REST polling every 30 seconds.

```ts
import { EVENT_UPDATE } from "nodelitterbot";

// Start receiving updates
await robot.subscribe();

// React to state changes
const unsubscribe = robot.on(EVENT_UPDATE, () => {
  console.log("Robot updated:", robot.status.text, "— drawer:", robot.wasteDrawerLevel + "%");
});

// Later — stop listening to events (robot is still subscribed)
unsubscribe();

// Stop all updates for this robot
await robot.unsubscribe();
```

### Subscribe during connect

```ts
await account.connect({
  username: "...",
  password: "...",
  loadRobots: true,
  subscribeForUpdates: true,  // Auto-subscribe every robot on load
});
```

---

## Error handling

```ts
import { LitterRobotLoginException, LitterRobotException, InvalidCommandException } from "nodelitterbot";

try {
  await account.connect({ username: "wrong@email.com", password: "badpass" });
} catch (err) {
  if (err instanceof LitterRobotLoginException) {
    console.error("Login failed:", err.message);
  } else if (err instanceof LitterRobotException) {
    console.error("API error:", err.message);
  }
}

try {
  await robot.setWaitTime(99); // Invalid value
} catch (err) {
  if (err instanceof InvalidCommandException) {
    console.error("Bad command:", err.message);
  }
}
```

---

## TypeScript usage

The package ships full `.d.ts` declarations. All types are exported:

```ts
import type {
  AccountOptions,
  ConnectOptions,
  TokenSet,
  LitterBoxStatusEntry,
  WeightMeasurement,
  WebSocketProtocol,
  RobotLike,
} from "nodelitterbot";
```

Enums are plain TypeScript enums/const objects and can be used in type positions:

```ts
import { LitterBoxStatus, NightLightMode, BrightnessLevel } from "nodelitterbot";
import type { LitterBoxStatusEntry } from "nodelitterbot";

function handleStatus(status: LitterBoxStatusEntry) {
  if (status === LitterBoxStatus.READY) { /* ... */ }
}
```

---

## Full example

```ts
import { Account, LitterRobot4, NightLightMode, EVENT_UPDATE } from "nodelitterbot";

async function main() {
  const account = new Account();

  await account.connect({
    username: process.env.LR_USERNAME!,
    password: process.env.LR_PASSWORD!,
    loadRobots: true,
    loadPets: true,
    subscribeForUpdates: true,
  });

  console.log("Robots:");
  for (const robot of account.robots) {
    console.log(" ", String(robot));

    robot.on(EVENT_UPDATE, () => {
      console.log(`  [${robot.name}] → ${robot.status.text}`);
    });
  }

  console.log("Pets:");
  for (const pet of account.pets) {
    console.log(" ", String(pet));
  }

  const lr4 = account.getRobots(LitterRobot4)[0];
  if (lr4) {
    await lr4.setNightLightMode(NightLightMode.AUTO);
    const history = await lr4.getActivityHistory(10);
    console.log("Last activity:", String(history[0]?.action ?? "none"));
  }

  // Keep process alive for 60 s to receive real-time events
  await new Promise((resolve) => setTimeout(resolve, 60_000));

  await account.disconnect();
}

main().catch(console.error);
```

---

## Supported devices

| Device | Transport | Notes |
|---|---|---|
| Litter-Robot 3 (with Connect) | WebSocket | REST + AWS IoT WebSocket |
| Litter-Robot 4 | WebSocket | GraphQL over `lr4.iothings.site` |
| Litter-Robot 5 | Polling (30 s) | REST via `ub.prod.iothings.site` |
| Litter-Robot 5 Pro | Polling (30 s) | Same as LR5, with camera extras |
| Feeder-Robot | WebSocket | Hasura GraphQL |

---

## License

MIT
