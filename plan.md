# Plan: TypeScript/Node.js Port of pylitterbot

## Overview
Full 1:1 port of [pylitterbot](https://github.com/natekspencer/pylitterbot) to TypeScript/Node.js 24, publishable as `nodelitterbot` on npm. Targets LR3, LR4, LR5, Feeder-Robot, and Pet profiles via Whisker's unofficial API.

---

## Architecture mapping (Python → TypeScript)

| Python concept | TypeScript equivalent |
|---|---|
| `asyncio` / `async/await` | `async/await` + `Promise` |
| `aiohttp.ClientSession` | `axios` (HTTP) |
| `aiohttp` WebSocket | `ws` package |
| `pycognito` / `Cognito` | `amazon-cognito-identity-js` |
| `jwt.decode` | `jsonwebtoken` (verify_signature: false) |
| `deepdiff.DeepDiff` | `deep-diff` npm package |
| `Event` (custom) | Wraps Node.js `EventEmitter` |
| `dataclass` | TypeScript `class` / `interface` |
| `ZoneInfo` | Intl.DateTimeFormat / luxon |
| `base64` | `Buffer.from()` |

---

## File structure

```
nodelitterbot/
├── src/
│   ├── index.ts                  # public exports
│   ├── account.ts
│   ├── activity.ts
│   ├── enums.ts
│   ├── event.ts
│   ├── exceptions.ts
│   ├── pet.ts
│   ├── session.ts
│   ├── sleepSchedule.ts
│   ├── transport.ts
│   ├── utils.ts
│   └── robot/
│       ├── index.ts              # Robot base
│       ├── litterrobot.ts        # LitterRobot abstract
│       ├── litterrobot3.ts
│       ├── litterrobot4.ts
│       ├── litterrobot5.ts
│       ├── feederrobot.ts
│       └── models.ts             # GraphQL fragment strings
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── README.md
```

---

## Key decoded constants

- Cognito USER_POOL_ID: `us-east-1_rjhNnZVAm`
- Cognito CLIENT_ID: `4552ujeu3aic90nf8qn53levmn`
- LR3 endpoint: `https://v2.api.whisker.iothings.site`
- LR3 API key decoded from: `cDduZE1vajYxbnBSWlA1Q1Z6OXY0VWowYkc3Njl4eTY3NThRUkJQYg==`
- LR3 WebSocket endpoint: `https://8s1fz54a82.execute-api.us-east-1.amazonaws.com/prod`
- LR4 endpoint: `https://lr4.iothings.site/graphql`
- LR5 endpoint: `https://ub.prod.iothings.site`
- Feeder endpoint: `https://cognito.hasura.iothings.site/v1/graphql`
- Feeder command endpoint key decoded from base64

---

## Phases

### Phase 1: Project setup
- `package.json`: name `nodelitterbot`, main/module/types pointing to dist, scripts for build/test
- `tsconfig.json`: target ES2022, module NodeNext, outDir dist, declarations
- `tsup.config.ts`: build to CJS + ESM, dts: true
- Dependencies: `amazon-cognito-identity-js` (ONLY — everything else is native Node 24)
- DevDeps: `typescript`, `@types/node`, `@types/amazon-cognito-identity-js`, `tsup`
- NO axios (use native fetch), NO ws (use native WebSocket Node 24), NO jsonwebtoken (inline base64 decode), NO deep-diff (inline JSON.stringify comparison)

### Phase 2: Core primitives (no deps on each other except utils→nothing)
1. `src/exceptions.ts` - LitterRobotException, LitterRobotLoginException, InvalidCommandException
2. `src/event.ts` - Event class wrapping EventEmitter; `emit(name)`, `on(name, cb) → unsubscribe fn`; EVENT_UPDATE constant
3. `src/enums.ts` - All command/status enums:
   - `FeederRobotCommand` (plain object/const)
   - `LitterBoxCommand` (const with ENDPOINT, PREFIX, CLEAN, etc.)
   - `LitterRobot4Command` (const)
   - `LitterRobot5Command` (const)
   - `LitterBoxStatus` enum with value, text, minimumCyclesLeft; `_missing_` → UNKNOWN
   - `BrightnessLevel` enum (LOW=25, MEDIUM=50, HIGH=100)
   - `GlobeMotorFaultStatus` enum + `fromRaw(raw)` static
   - `HopperStatus`, `LitterLevelState`, `NightLightMode` enums
4. `src/utils.ts` - decode, encode, toTimestamp, pluralize, roundTime, todayAtTime, urljoin, utcnow, redact, dig, firstValue, toEnum, calculateLitterLevel, sendDeprecationWarning
5. `src/activity.ts` - Activity interface/class, Insight class
6. `src/sleepSchedule.ts` - DayOfWeek, SleepScheduleDay, SleepSchedule with parse/fromTimestamp/getWindow/isActive

### Phase 3: Session & Auth
7. `src/session.ts`:
   - Abstract `Session` extends `Event`; `get/post/patch` → `request()`; abstract `asyncGetIdToken()`, `isTokenValid()`, `tokens`, `refreshTokens()`
   - `LitterRobotSession` extends Session; uses `amazon-cognito-identity-js` CognitoUserPool + CognitoUser for SRP auth; `login(username, password)`, `getUsedId()` (extracts 'mid' from JWT), `generateArgs()` for x-api-key injection

### Phase 4: Transport
8. `src/transport.ts`:
   - `Transport` abstract with `start(robot)/stop(robot)`
   - `WebSocketProtocol<T>` dataclass-style interface: `wsConfigFactory`, `subscribeFactory?`, `unsubscribeFactory?`, `messageHandler?`
   - `WebSocketMonitor` - shared WS per robot class; reconnect with exponential backoff; dispatches to all registered listeners; uses `ws` package
   - `PollingTransport` - per-robot polling loop using `setInterval`-style async loop

### Phase 5: Robots
9. `src/robot/index.ts` - abstract `Robot` extends `Event`:
   - Abstract props: `isOnboarded`, `isOnline`, `nightLightModeEnabled`, `panelLockEnabled`, `powerStatus`
   - Props: `id`, `model`, `name`, `serial`, `setupDate`, `timezone`
   - Abstract methods: `refresh()`, `setName()`, `setNightLight()`, `setPanelLockout()`
   - `_updateData(data, partial?, callback?)`, `_get/patch/post()`, `subscribe/unsubscribe()`
   - Static `fetchForAccount(account)`
10. `src/robot/models.ts` - literal GraphQL strings for LR4, LR5 (inline since no template tag needed), FeederRobot
11. `src/robot/litterrobot.ts` - `LitterRobot` extends `Robot`:
    - Abstract: `cleanCycleWaitTimeMinutes`, `isDrawerFullIndicatorTriggered`, `isSleeping`, `isWasteDrawerFull`, `status`, `statusCode`, `wasteDrawerLevel`, `dispatchCommand()`, `parseSleeipInfo()`, `getActivityHistory()`, `getInsight()`
    - Concrete: `cycleCapacity`, `cycleCount`, `cyclesAfterDrawerFull`, `isOnboarded`, `lastSeen`, `powerStatus`, `sleepModeEnabled`, `sleepModeStartTime`, `sleepModeEndTime`, `sleepSchedule`, `statusText`, `startCleaning()`, `setNightLight()`, `setPanelLockout()`, `setPowerStatus()`, `setWaitTime()`
12. `src/robot/litterrobot3.ts` - LitterRobot3, REST+WebSocket: endpoints, status map, sleep parsing from timestamp, dispatch via POST dispatch-commands, refresh via GET, ws message handler
13. `src/robot/litterrobot4.ts` - LitterRobot4, GraphQL mutations/queries for commands, LR4_ENDPOINT, status maps, WebSocket with graphql-ws protocol
14. `src/robot/litterrobot5.ts` - LitterRobot5, REST endpoints, PollingTransport, all LR5-specific props/methods, status priority algorithm
15. `src/robot/feederrobot.ts` - FeederRobot, Hasura GraphQL, feeding schedule, nextFeeding calculation

### Phase 6: Pet & Account
16. `src/pet.ts` - Pet extends Event, all props (id, name, petType, gender, weight, breeds, etc.), query statics (queryByUser, queryById, queryWeightHistory, queryGraphqlApi), fetchPetsForUser, refresh
17. `src/account.ts` - Account: connect(), disconnect(), loadRobots(), loadPets(), refreshRobots(), refreshUser(), getMonitorFor(), getActualBearerAuthorization()

### Phase 7: Exports
18. `src/index.ts` - re-export Account, Robot, LitterRobot, LitterRobot3, LitterRobot4, LitterRobot5, FeederRobot, Pet, all enums, exceptions

---

## Decisions
- Build tool: `tsup` (produces CJS + ESM + .d.ts; simple config)
- HTTP: `axios` (better error handling than native fetch for this use case)
- Auth: `amazon-cognito-identity-js` (closest to pycognito, well-maintained)
- No runtime validation library needed (simple type checks inline)
- Package name: `nodelitterbot` (matches workspace folder)
- Module: `"type": "module"` in package.json with ESM-first dist but also CJS for compatibility

---

## Verification
1. `npm run build` completes without errors
2. `tsc --noEmit` has no type errors
3. Manual smoke test: can instantiate Account, call connect(), see robots listed
4. All enums decode to correct values (spot check LitterBoxStatus.BONNET_REMOVED = "BR")
5. dist/index.d.ts exports all expected types
