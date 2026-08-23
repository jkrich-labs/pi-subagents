/**
 * S-03 testing model pins (user decision 2026-08-23):
 * all test children run gpt-5.6-luna via vercel-ai-gateway.
 */
export const TESTING_PROVIDER = "vercel-ai-gateway";
export const TESTING_MODEL = "openai/gpt-5.6-luna-fast";
export const TESTING_THINKING = "off"; // thinking off keeps LF rounds cheap & fast
