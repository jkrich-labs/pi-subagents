/**
 * S-03 testing model pins (user decision 2026-08-23):
 * all test children run gpt-5.6-luna.
 */
export const TESTING_PROVIDER = "opencode-go";
export const TESTING_MODEL = "gpt-5.6-luna";
/** gpt-5.6-luna's thinking floor is "low" — off/minimal clamp to low. */
export const TESTING_THINKING = "low";
