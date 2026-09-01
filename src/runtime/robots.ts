interface RobotsGroup {
  agents: string[];
  rules: Array<{ allow: boolean; pattern: string }>;
  crawlDelaySeconds?: number;
}

export interface RobotsVerdict {
  allowed: boolean;
  crawlDelayMs?: number;
}

/** Parse a robots.txt body into user-agent groups. */
export function parseRobots(body: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;
  let lastWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'disallow' || field === 'allow') {
      // An empty Disallow means "allow everything" — no rule needed.
      if (value) current.rules.push({ allow: field === 'allow', pattern: value });
    } else if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
    }
  }
  return groups;
}

/** Convert a robots.txt path pattern (with * and $) into a RegExp. */
function patternToRegExp(pattern: string): RegExp {
  let source = '^';
  for (const ch of pattern) {
    if (ch === '*') source += '.*';
    else if (ch === '$') source += '$';
    else source += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(source);
}

function selectGroup(groups: RobotsGroup[], userAgent: string): RobotsGroup | undefined {
  const ua = userAgent.toLowerCase();
  let best: RobotsGroup | undefined;
  let bestLen = -1;
  for (const group of groups) {
    for (const agent of group.agents) {
      if (agent === '*') {
        if (bestLen < 0) best ??= group;
      } else if (ua.includes(agent) && agent.length > bestLen) {
        best = group;
        bestLen = agent.length;
      }
    }
  }
  return best;
}

export function evaluateRobots(
  groups: RobotsGroup[],
  userAgent: string,
  pathWithQuery: string,
): RobotsVerdict {
  const group = selectGroup(groups, userAgent);
  if (!group) return { allowed: true };

  // Longest-match wins; on a tie, Allow wins (Google semantics).
  let winner: { allow: boolean; length: number } | undefined;
  for (const rule of group.rules) {
    if (patternToRegExp(rule.pattern).test(pathWithQuery)) {
      const length = rule.pattern.length;
      if (
        !winner ||
        length > winner.length ||
        (length === winner.length && rule.allow && !winner.allow)
      ) {
        winner = { allow: rule.allow, length };
      }
    }
  }
  const verdict: RobotsVerdict = { allowed: winner?.allow ?? true };
  if (group.crawlDelaySeconds !== undefined) {
    verdict.crawlDelayMs = group.crawlDelaySeconds * 1000;
  }
  return verdict;
}

export type RobotsFetcher = (
  url: string,
) => Promise<{ status: number; body: string }>;

/** Per-origin robots.txt cache. */
export class RobotsCache {
  #cache = new Map<string, RobotsGroup[] | 'unavailable'>();

  constructor(
    private readonly fetcher: RobotsFetcher,
    private readonly userAgent: string,
  ) {}

  async check(url: string): Promise<RobotsVerdict> {
    const parsed = new URL(url);
    let groups = this.#cache.get(parsed.origin);
    if (groups === undefined) {
      try {
        const res = await this.fetcher(new URL('/robots.txt', parsed.origin).href);
        groups = res.status >= 200 && res.status < 300 ? parseRobots(res.body) : 'unavailable';
      } catch {
        groups = 'unavailable';
      }
      this.#cache.set(parsed.origin, groups);
    }
    if (groups === 'unavailable') return { allowed: true };
    return evaluateRobots(groups, this.userAgent, parsed.pathname + parsed.search);
  }
}
