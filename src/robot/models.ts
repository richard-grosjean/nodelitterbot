import { utcnow } from "../utils.js";

// ---------------------------------------------------------------------------
// GraphQL fragment models
// ---------------------------------------------------------------------------

const SLEEP_WAKE_ENABLED_MODEL = `
{
  sleepTime
  wakeTime
  isEnabled
}
`;

export const LITTER_ROBOT_4_MODEL = `
{
    unitId
    name
    serial
    userId
    espFirmware
    picFirmwareVersion
    picFirmwareVersionHex
    laserBoardFirmwareVersion
    laserBoardFirmwareVersionHex
    wifiRssi
    unitPowerType
    catWeight
    displayCode
    unitTimezone
    unitTime
    cleanCycleWaitTime
    isKeypadLockout
    nightLightMode
    nightLightBrightness
    isPanelSleepMode
    panelSleepTime
    panelWakeTime
    weekdaySleepModeEnabled {
        Sunday ${SLEEP_WAKE_ENABLED_MODEL}
        Monday ${SLEEP_WAKE_ENABLED_MODEL}
        Tuesday ${SLEEP_WAKE_ENABLED_MODEL}
        Wednesday ${SLEEP_WAKE_ENABLED_MODEL}
        Thursday ${SLEEP_WAKE_ENABLED_MODEL}
        Friday ${SLEEP_WAKE_ENABLED_MODEL}
        Saturday ${SLEEP_WAKE_ENABLED_MODEL}
    }
    unitPowerStatus
    sleepStatus
    robotStatus
    globeMotorFaultStatus
    pinchStatus
    catDetect
    isBonnetRemoved
    isNightLightLEDOn
    odometerPowerCycles
    odometerCleanCycles
    panelBrightnessHigh
    panelBrightnessLow
    smartWeightEnabled
    odometerEmptyCycles
    odometerFilterCycles
    isDFIResetPending
    DFINumberOfCycles
    DFILevelPercent
    isDFIFull
    DFIFullCounter
    DFITriggerCount
    litterLevel
    DFILevelMM
    isCatDetectPending
    globeMotorRetractFaultStatus
    robotCycleStatus
    robotCycleState
    weightSensor
    isOnline
    isOnboarded
    isProvisioned
    isDebugModeActive
    lastSeen
    sessionId
    setupDateTime
    isFirmwareUpdateTriggered
    firmwareUpdateStatus
    wifiModeStatus
    isUSBPowerOn
    USBFaultStatus
    isDFIPartialFull
    isLaserDirty
    surfaceType
    hopperStatus
    scoopsSavedCount
    isHopperRemoved
    optimalLitterLevel
    litterLevelPercentage
    litterLevelState
}
`;

const feedingFilter = (): string => {
  const since = new Date(utcnow().getTime() - 86_400_000).toISOString();
  return `(
    order_by: { timestamp: desc }
    where: {
        _and: [
            { status: { _eq: dispensed } }
            { timestamp: { _gte: "${since}" } }
        ]
    }
)`;
};

export const getFeederRobotModel = (): string => `
{
    id
    name
    serial
    timezone
    isEighthCupEnabled
    created_at
    household_id
    state {
        id
        info
        updated_at
        active_schedule {
            id
            name
            meals
            created_at
        }
    }
    feeding_snack ${feedingFilter()} {
        timestamp
        amount
    }
    feeding_meal ${feedingFilter()} {
        timestamp
        amount
        meal_name
        meal_number
        meal_total_portions
    }
}
`;
