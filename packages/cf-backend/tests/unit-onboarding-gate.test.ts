/**
 * The onboarding gate's wiring, asserted at the source: there is no DOM
 * harness in this app, so what a test can honestly pin down is that the gate
 * sits above the shell — an account that has never finished setup reaches the
 * wizard whatever URL it landed on, and the wizard mounts above Layout rather
 * than inside it. The gate's own logic is pure and covered in core's
 * unit-account.test.ts.
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

    // The gate element encloses the Layout route, not a sibling of it.
    const gate = app.indexOf('<AccountProvider><OnboardingGate /></AccountProvider>');
    const layout = app.indexOf('element={<Layout />}');

    expect(gate).toBeGreaterThanOrEqual(0);
    expect(layout).toBeGreaterThan(gate);
  });

  test('the gate reads the shared profile and sends only a new account to the wizard', () => {
    expect(app).toContain('needsOnboarding');
    expect(app).toContain('Navigate to={APP_ROUTES.welcome}');
    // /welcome stays reachable for anyone: no Navigate sends an established
    // or onboarded account back home from it.
    expect(app).not.toContain('Navigate to={APP_ROUTES.home}');
  });
});
