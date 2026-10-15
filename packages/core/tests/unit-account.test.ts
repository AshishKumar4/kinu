import { describe, expect, test } from 'bun:test';
import {
  APP_ROUTES, displayNameProblem, needsOnboarding,
  routeTemplateOf,
} from '../src/index';

describe('needsOnboarding', () => {
  test('a failed profile read never locks the app behind the wizard', () => {
    expect(needsOnboarding(null)).toBe(false);
  });

  test('a fresh account — no stamp, no workspace — lands on the wizard', () => {
    expect(needsOnboarding({ onboardedAt: null, workspaceCount: 0 })).toBe(true);
  });

  test('an account that owns a workspace is established, stamp or not', () => {
    expect(needsOnboarding({ onboardedAt: null, workspaceCount: 1 })).toBe(false);
  });

  test('a stamped account is done even with no workspace yet', () => {
    expect(needsOnboarding({ onboardedAt: 1_700_000_000_000, workspaceCount: 0 })).toBe(false);
  });
});

describe('displayNameProblem', () => {
  test('padding is not part of the name', () => {
    expect(displayNameProblem('  Ashish Rao  ')).toBeNull();
  });
});

describe('the welcome route', () => {
  test('is a template a render-failure report may carry', () => {
    expect(routeTemplateOf('/welcome')).toBe(APP_ROUTES.welcome);
    expect(APP_ROUTES.welcome).toBe('/welcome');
  });
});

describe('the Drive routes', () => {
  test('a folder below /drive reports as the splat, and a live slate keeps its own template', () => {
    expect(routeTemplateOf('/drive')).toBe(APP_ROUTES.drive);
    expect(routeTemplateOf('/drive/blueprints')).toBe(APP_ROUTES.driveFolder);
    expect(routeTemplateOf('/drive/projects/ops/deploy')).toBe(APP_ROUTES.driveFolder);
    expect(routeTemplateOf('/s/ws/board')).toBe(APP_ROUTES.liveSlate);
    expect(routeTemplateOf('/drivex/y')).toBe('/unmatched');
  });
});
