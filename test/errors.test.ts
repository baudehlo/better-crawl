import { describe, expect, it } from 'vitest';
import {
  ArtifactFormatError,
  BetterCrawlError,
  GenerationFailedError,
  GenerationRefusedError,
  HealFailedError,
  MissingInputError,
  NoMatchError,
  PageBudgetExceededError,
  PlaywrightMissingError,
  RobotsDisallowedError,
  RunTimeoutError,
  UnknownInputError,
  UnknownSelectorError,
} from '../src/errors.js';

describe('error classes', () => {
  it('BetterCrawlError carries a code and its subclass name', () => {
    const err = new BetterCrawlError('boom', 'BOOM');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('BOOM');
    expect(err.name).toBe('BetterCrawlError');
    expect(err.message).toBe('boom');
  });

  it('ArtifactFormatError', () => {
    const err = new ArtifactFormatError('bad artifact');
    expect(err.code).toBe('ARTIFACT_FORMAT');
    expect(err.name).toBe('ArtifactFormatError');
    expect(err).toBeInstanceOf(BetterCrawlError);
  });

  it('UnknownInputError names the input', () => {
    const err = new UnknownInputError('username');
    expect(err.code).toBe('UNKNOWN_INPUT');
    expect(err.inputName).toBe('username');
    expect(err.message).toContain('"username"');
  });

  it('MissingInputError names the input', () => {
    const err = new MissingInputError('password');
    expect(err.code).toBe('MISSING_INPUT');
    expect(err.inputName).toBe('password');
    expect(err.message).toContain('"password"');
  });

  it('UnknownSelectorError names the selector', () => {
    const err = new UnknownSelectorError('productRow');
    expect(err.code).toBe('UNKNOWN_SELECTOR');
    expect(err.selectorName).toBe('productRow');
  });

  it('NoMatchError carries selector name, css, and page URL', () => {
    const err = new NoMatchError('row', 'li.row', 'http://x/page');
    expect(err.code).toBe('NO_MATCH');
    expect(err.selectorName).toBe('row');
    expect(err.css).toBe('li.row');
    expect(err.pageUrl).toBe('http://x/page');
    expect(err.message).toContain('li.row');
  });

  it('PageBudgetExceededError carries the budget', () => {
    const err = new PageBudgetExceededError(7);
    expect(err.code).toBe('PAGE_BUDGET');
    expect(err.maxPages).toBe(7);
  });

  it('RunTimeoutError carries the timeout', () => {
    const err = new RunTimeoutError(1234);
    expect(err.code).toBe('RUN_TIMEOUT');
    expect(err.timeoutMs).toBe(1234);
  });

  it('RobotsDisallowedError carries the URL', () => {
    const err = new RobotsDisallowedError('http://x/private');
    expect(err.code).toBe('ROBOTS_DISALLOWED');
    expect(err.url).toBe('http://x/private');
  });

  it('PlaywrightMissingError explains the install', () => {
    const err = new PlaywrightMissingError();
    expect(err.code).toBe('PLAYWRIGHT_MISSING');
    expect(err.message).toContain('npm install playwright');
  });

  it('GenerationRefusedError carries the detail', () => {
    const err = new GenerationRefusedError('content filter');
    expect(err.code).toBe('REFUSED');
    expect(err.detail).toBe('content filter');
  });

  it('GenerationFailedError exposes the last artifact and reports', () => {
    const err = new GenerationFailedError('no luck', { fake: true }, [{ ok: false }]);
    expect(err.code).toBe('GENERATION_FAILED');
    expect(err.lastArtifact).toEqual({ fake: true });
    expect(err.reports).toHaveLength(1);
  });

  it('HealFailedError exposes the reports', () => {
    const err = new HealFailedError('drifted too far', [{ ok: false }, { ok: false }]);
    expect(err.code).toBe('HEAL_FAILED');
    expect(err.reports).toHaveLength(2);
  });
});
