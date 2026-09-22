/**
 * Asserted at the source (no DOM harness): the gate mounts above Layout. Gate logic is covered in core's unit-account.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const app = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf8');

describe('the onboarding gate is mounted above the shell', () => {
  test('OnboardingGate wraps Layout, and welcome routes to WelcomePage', () => {
    expect(app).toContain('<AccountProvider><OnboardingGate /></AccountProvider>');
    expect(app).toContain('path={APP_ROUTES.welcome}');
    expect(app).toContain('<WelcomePage');

    const gate = app.indexOf('<AccountProvider><OnboardingGate /></AccountProvider>');
    const layout = app.indexOf('element={<Layout />}');

    expect(gate).toBeGreaterThanOrEqual(0);
    expect(layout).toBeGreaterThan(gate);
  });

  test('the gate reads the shared profile and sends only a new account to the wizard', () => {
    expect(app).toContain('needsOnboarding');
    expect(app).toContain('Navigate to={APP_ROUTES.welcome}');
    // /welcome stays reachable: nothing navigates an onboarded account home from it.
    expect(app).not.toContain('Navigate to={APP_ROUTES.home}');
  });
});
