/** Base class for every error thrown by better-crawl. */
export class BetterCrawlError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ArtifactFormatError extends BetterCrawlError {
  constructor(message: string) {
    super(message, 'ARTIFACT_FORMAT');
  }
}

export class UnknownInputError extends BetterCrawlError {
  constructor(readonly inputName: string) {
    super(
      `Unknown input "${inputName}" — not declared in the artifact manifest`,
      'UNKNOWN_INPUT',
    );
  }
}

export class MissingInputError extends BetterCrawlError {
  constructor(readonly inputName: string) {
    super(
      `Input "${inputName}" is required by this crawler but no value was provided`,
      'MISSING_INPUT',
    );
  }
}

export class UnknownSelectorError extends BetterCrawlError {
  constructor(readonly selectorName: string) {
    super(
      `Unknown selector "${selectorName}" — not declared in the artifact manifest`,
      'UNKNOWN_SELECTOR',
    );
  }
}

/** A named selector matched nothing where the code required at least one match. */
export class NoMatchError extends BetterCrawlError {
  constructor(
    readonly selectorName: string,
    readonly css: string,
    readonly pageUrl: string,
  ) {
    super(
      `Selector "${selectorName}" (${css}) matched 0 elements on ${pageUrl}`,
      'NO_MATCH',
    );
  }
}

export class PageBudgetExceededError extends BetterCrawlError {
  constructor(readonly maxPages: number) {
    super(`Page budget exhausted (maxPages: ${maxPages})`, 'PAGE_BUDGET');
  }
}

export class RunTimeoutError extends BetterCrawlError {
  constructor(readonly timeoutMs: number) {
    super(`Crawl exceeded wall-clock timeout of ${timeoutMs}ms`, 'RUN_TIMEOUT');
  }
}

export class RobotsDisallowedError extends BetterCrawlError {
  constructor(readonly url: string) {
    super(
      `robots.txt disallows fetching ${url} (pass ignoreRobots: true to override)`,
      'ROBOTS_DISALLOWED',
    );
  }
}

export class PlaywrightMissingError extends BetterCrawlError {
  constructor() {
    super(
      'This operation needs playwright, which is an optional peer dependency. ' +
        'Install it with: npm install playwright && npx playwright install chromium',
      'PLAYWRIGHT_MISSING',
    );
  }
}

/** The LLM (or its safety layer) refused the request. */
export class GenerationRefusedError extends BetterCrawlError {
  constructor(readonly detail: string) {
    super(`The model refused to complete the request: ${detail}`, 'REFUSED');
  }
}

/** Thrown when generation exhausts its repair budget without a passing artifact. */
export class GenerationFailedError<TArtifact = unknown, TReport = unknown> extends BetterCrawlError {
  constructor(
    message: string,
    /** The last (failing) artifact candidate — inspectable/salvageable. */
    readonly lastArtifact: TArtifact | undefined,
    /** RunReports from every self-test attempt, oldest first. */
    readonly reports: TReport[],
  ) {
    super(message, 'GENERATION_FAILED');
  }
}

/** Thrown when a heal-enabled run exhausts its heal budget. */
export class HealFailedError<TReport = unknown> extends BetterCrawlError {
  constructor(
    message: string,
    readonly reports: TReport[],
  ) {
    super(message, 'HEAL_FAILED');
  }
}
