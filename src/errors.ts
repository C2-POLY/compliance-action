/** An error whose message is safe to show to the user (never contains a token). */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionError';
  }
}

export const SPEC_URL = 'https://github.com/C2-POLY/compliance-spec/blob/main/spec/manifest.md';
