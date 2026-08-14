/**
 * Failures the Payhip automation raises internally.
 *
 * These stay INSIDE the adapter — `PayhipProductPublisher` maps them onto the
 * core's `CheckoutPublishError`, so nothing above the port knows Payhip exists.
 * They are classes rather than strings because the retry loop has to tell them
 * apart: a session that has expired must never be retried, a navigation timeout
 * should be.
 */

/** Where the diagnostics for a failed run were written. */
export interface PayhipDebugArtifacts {
  screenshotPath?: string | undefined;
  htmlPath?: string | undefined;
  url?: string | undefined;
}

export abstract class PayhipError extends Error {
  debug: PayhipDebugArtifacts = {};
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
  /** All captured artifact paths, for the error the operator finally reads. */
  get debugPaths(): string[] {
    return [this.debug.screenshotPath, this.debug.htmlPath].filter((p): p is string => Boolean(p));
  }
}

/**
 * The stored session is no longer logged in.
 *
 * The message is written for the OPERATOR, not for a log grep: it names the
 * exact command that fixes it. This is deliberately never retried and never
 * repaired in place — a headless login would walk into 2FA/captcha, and typing
 * credentials in a worker is precisely what the stored-session design avoids.
 */
export class PayhipSessionExpired extends PayhipError {
  constructor(detail = 'the automation landed on the Payhip login page') {
    super(
      `Payhip session expired — ${detail}. ` +
        'Re-connect it by running `npm run payhip:connect` on a machine with a display, ' +
        'logging in by hand when the browser opens. No product was created.',
    );
  }
}

/** No session has ever been stored — a first-run/setup problem, not an expiry. */
export class PayhipNotConfigured extends PayhipError {
  constructor() {
    super(
      'No Payhip session is stored. Run `npm run payhip:connect` once on a machine with a ' +
        'display to log in by hand; every headless run then reuses that session.',
    );
  }
}

/** A timeout, a navigation failure, a slow upload — worth another attempt. */
export class PayhipTransientError extends PayhipError {}

/**
 * Payhip refused the product: a price it will not take, a file over its size
 * limit, a required field it did not show us. Retrying does the same thing
 * again, so the retry loop stops on this.
 */
export class PayhipRejected extends PayhipError {}

/**
 * The product was created but we could not read back its link.
 *
 * Its own type because it is the ONE failure where a retry is actively harmful:
 * the book is already listed on the store, and running the flow again lists it
 * twice. Surfaced to the operator with that fact stated plainly, so they open
 * the dashboard and paste the link rather than pressing the button again.
 */
export class PayhipProductCreatedButUnreadable extends PayhipError {
  constructor(detail: string) {
    super(
      `The product was created on Payhip but its buy link could not be read (${detail}). ` +
        'Do NOT run this again — the book is already listed and a second run would list it twice. ' +
        'Open the Payhip dashboard, copy the product link, and paste it into the checkout field.',
    );
  }
}
