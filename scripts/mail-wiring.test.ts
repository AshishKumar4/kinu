// What keeps mail to a deployment's own addresses from arriving, as the inbound row reads it where it may hold no box
// (production, rc31 2026-10-23): the Worker an origin names, and each problem said once. Defends: a check that reads the
// wrong deployment's aliases, and privacy@ reaching a username with no box read as fine.
import { describe, expect, test } from 'bun:test';
import { deploymentMailOf, wiringProblems, type DeploymentMail, type MailWiring } from './mail-wiring';

/** A Worker config in wrangler's shape: production at the top, staging as an environment. */
const CONFIG = `{
  "name": "kinu",
  // production
  "routes": [{ "pattern": "kinu.run", "custom_domain": true }, { "pattern": "*.kinu.run/*", "zone_name": "kinu.run" }],
  "vars": { "EMAIL_DOMAIN": "kinu.run", "MAIL_ALIASES": "{\\"privacy\\": \\"ashish\\"}" },
  "env": {
    "staging": {
      "routes": [{ "pattern": "staging.kinu.run", "custom_domain": true }, { "pattern": "staging.kinu.run/*", "zone_name": "kinu.run" }],
      "vars": { "EMAIL_DOMAIN": "staging.kinu.run", "MAIL_ALIASES": "{\\"privacy\\": \\"eval\\"}" }
    }
  }
}`;

const PRODUCTION: DeploymentMail = { worker: 'kinu', domain: 'kinu.run', zone: 'kinu.run', aliases: new Map([['privacy', 'ashish']]) };

/** Mail to privacy@ as it arrives: Email Routing's MX, the catch-all to the Worker, a box, nothing suppressed. */
const ARRIVING: MailWiring = {
  mx: ['route1.mx.cloudflare.net.', 'route2.mx.cloudflare.net.', 'route3.mx.cloudflare.net.'],
  routes: [{ address: 'privacy@kinu.run', workers: ['kinu'] }],
  targets: [{ address: 'privacy@kinu.run', username: 'ashish', held: true }],
  suppressed: [],
};

describe('the deployment an origin names', () => {
  test("is the Worker serving its host as a custom domain, with that Worker's own mail", () => {
    expect(deploymentMailOf('https://kinu.run', CONFIG)).toEqual(PRODUCTION);
    expect(deploymentMailOf('https://staging.kinu.run', CONFIG)).toEqual({
      worker: 'kinu-staging', domain: 'staging.kinu.run', zone: 'kinu.run', aliases: new Map([['privacy', 'eval']]),
    });
  });

  test('a host no Worker serves is refused, never read as another deployment', () => {
    expect(() => deploymentMailOf('https://elsewhere.example', CONFIG)).toThrow('no Worker');
  });
});

describe('what keeps mail to its own addresses from arriving', () => {
  test('nothing, when each step holds', () => {
    expect(wiringProblems(PRODUCTION, ARRIVING)).toEqual([]);
  });

  test('privacy@ reaching a username with no box is a problem, said in those words', () => {
    expect(wiringProblems(PRODUCTION, { ...ARRIVING, targets: [{ address: 'privacy@kinu.run', username: 'ashish', held: false }] }))
      .toEqual(['privacy@kinu.run reaches ashish, which has no box, so mail to it is refused.']);
  });

  test('another MX, a rule to another Worker, and a suppressed address are each one problem', () => {
    const problems = wiringProblems(PRODUCTION, {
      ...ARRIVING, mx: ['mx.elsewhere.example.'], routes: [{ address: 'privacy@kinu.run', workers: ['kinu-staging'] }], suppressed: ['privacy@kinu.run'],
    });

    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain("is not Cloudflare Email Routing's");
    expect(problems[1]).toContain('to kinu-staging, not kinu');
    expect(problems[2]).toContain('has suppressed privacy@kinu.run');
  });
});
