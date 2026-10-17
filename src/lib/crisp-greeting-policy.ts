export const CRISP_GREETING_MAX_LENGTH = 120;
export const CRISP_FIRST_GREETING = "Hi! How can we help you today?";
export const CRISP_REVISIT_GREETING = "Welcome back! How can we help?";

export function validateCrispGreeting(message: string, label: string): void {
  if (message.length > CRISP_GREETING_MAX_LENGTH) {
    throw new Error(`${label} must be ${CRISP_GREETING_MAX_LENGTH} characters or fewer.`);
  }
  if (/\{\{\s*name\s*\}\}/i.test(message)) {
    throw new Error(`${label} must not use {{name}}; Crisp nicknames are not verified real names.`);
  }
}
