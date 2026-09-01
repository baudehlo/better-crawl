import { describe, expect, it } from 'vitest';
import * as betterCrawl from '../src/index.js';
import { DEFAULT_USER_AGENT, VERSION } from '../src/version.js';

describe('public API surface', () => {
  it('exports the documented entry points', () => {
    expect(typeof betterCrawl.generateCrawler).toBe('function');
    expect(typeof betterCrawl.runCrawler).toBe('function');
    expect(typeof betterCrawl.loadArtifact).toBe('function');
    expect(typeof betterCrawl.Artifact).toBe('function');
    expect(typeof betterCrawl.CrawlHandle).toBe('function');
    expect(betterCrawl.ARTIFACT_FORMAT_VERSION).toBe(1);
  });

  it('exports every error class', () => {
    expect(typeof betterCrawl.BetterCrawlError).toBe('function');
    expect(typeof betterCrawl.GenerationFailedError).toBe('function');
    expect(typeof betterCrawl.HealFailedError).toBe('function');
    expect(typeof betterCrawl.NoMatchError).toBe('function');
  });

  it('version constants are consistent', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(DEFAULT_USER_AGENT).toContain(`better-crawl/${VERSION}`);
  });
});
