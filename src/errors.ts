/** An error whose message is safe to show to the user (never contains a token). */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionError';
  }
}

// The engine (@c2-poly/compliance-core) throws ComplianceError, whose message is just as safe to show: main.ts reports both alike.
export { ComplianceError, SPEC_URL } from '@c2-poly/compliance-core';
