/**
 * @vitest-environment node
 */
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { parseMailRecipient } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';

// The privacy policy promises that deleting an account deletes everything it has. Priya Raman's account holds a
// workspace with a preview, a device, a credential, mail with an attachment, a Drive file, feedback, marks in Explore,
// an operator's audit row and a built-in sign-in; Dana's account at Northwind shared a board with her. The census reads
// every one of those stores for Priya before her account is deleted, and after.

const EMAIL = 'priya.raman@example.com';

const MIME = [
  'From: Dana Whitfield <dana@northwind.io>', 'To: priya@kinu.run', 'Subject: Webhook signing secret', 'Message-ID: <signing@northwind.io>',
  'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: text/plain', '', 'The new secret is attached.', '--B',
  'Content-Type: text/plain', 'Content-Disposition: attachment; filename="secret.txt"', '', 'whsec_northwind', '--B--', '',
].join('\r\n');

const account = (id: string) => env.CENSUS_ACCOUNT.get(env.CENSUS_ACCOUNT.idFromName(id));

const workspace = (name: string) => env.CENSUS_WORKSPACE.get(env.CENSUS_WORKSPACE.idFromName(name));

const control = () => env.CENSUS_CONTROL.get(env.CENSUS_CONTROL.idFromName('site'));

describe("deleting an account on real workerd, every store's census", () => {
  it("leaves nothing of the person in any store, theirs or another owner's", async () => {
    const [priyaId = '', dana = ''] = await account('census-ids').accountsOf([EMAIL, 'dana@northwind.io']);
    const priya = { userId: priyaId, email: EMAIL };
    const mailbox = env.CENSUS_MAILBOX.get(env.CENSUS_MAILBOX.idFromName(priya.userId));
    const name = env.CENSUS_MAILNAME.get(env.CENSUS_MAILNAME.idFromName('priya'));
    const recipient = parseMailRecipient('priya@kinu.run', 'kinu.run');

    if (recipient === null) throw new Error('priya@kinu.run is no Kinu address');

    await account(priya.userId).seedPriya(priya);
    await account(dana).seedDana(priya);
    await workspace('northwind-api').seedShareWith(priya);
    await name.claim('priya', priya.userId);
    await mailbox.open({ userId: priya.userId, email: priya.email, username: 'priya', assistant: null });
    await mailbox.deliver({ raw: new TextEncoder().encode(MIME), envelopeFrom: 'dana@northwind.io', recipient });
    await control().seedPerson(priya);
    await account('kinu:builtin-accounts').seedSignIn(priya);

    // Dana's card reaches Priya's account on its own job, run by Dana's account's alarm.
    while (await runDurableObjectAlarm(account(dana)));

    // Read from Dana's account where a read would make Priya's again.
    const census = async () => ({
      account: await account(priya.userId).accountCensus(),
      mailbox: await mailbox.mailCensus(priya.userId),
      mailName: await name.lookup(),
      driveShards: await account(dana).driveCensus(priya.userId),
      preview: await account(dana).previewCensus('priya-notes'),
      controlPlane: await control().controlCensus(priya),
      signIn: await account('kinu:builtin-accounts').signInCensus(priya),
      danaWorkspace: await workspace('northwind-api').shareCensus(priya),
      danaAccount: await account(dana).sentTo(priya),
    });

    const before = await census();
    console.log(`census before: ${JSON.stringify(before)}`);

    expect(before).toMatchObject({
      account: { user_workspaces: 1, user_devices: 1, user_credentials: 1, user_share_cards: 1, user_profile: 1 },
      mailbox: { mail_box: 1, mail_messages: 1, mail_attachments: 1 },
      mailName: { state: 'active', user_id: priya.userId },
      preview: true,
      controlPlane: { cp_users: 1, cp_workspaces: 1, cp_feedback: 1, cp_audit_naming: 1, gallery_stars: 1, gallery_reports: 1, gallery_installs: 1, feedback_objects: 1 },
      signIn: 1,
      danaWorkspace: { slate_share_users: 1, slate_live_share_users: 1, slate_viewer_requests: 1, slate_edit_marks: 1 },
      danaAccount: { cards: 1, overviews: 1 },
    });
    expect(before.mailbox['r2_objects']).toBeGreaterThan(0);
    expect(before.driveShards).toBeGreaterThan(0);

    // The account's own delete; its object aborts a tick after, so the answer or the `destroyed` sentinel both count.
    try {
      expect(await account(priya.userId).deleteThis()).toMatchObject({ ok: true, workspaces: 1 });
    } catch (cause) {
      expect(renderThrownChain({ cause })).toContain('destroyed');
    }

    const after = await census();
    console.log(`census after: ${JSON.stringify(after)}`);

    for (const [table, rows] of Object.entries(after.account)) expect({ table, rows }).toEqual({ table, rows: 0 });

    for (const [table, rows] of Object.entries(after.mailbox)) expect({ table, rows }).toEqual({ table, rows: 0 });

    expect(after).toMatchObject({
      // Retired: kept, owned by no one (docs/MAIL.md §11).
      mailName: { label: 'priya', user_id: '' },
      driveShards: 0,
      preview: false,
      controlPlane: {
        cp_users: 0, cp_workspaces: 0, cp_feedback: 0, cp_audit_naming: 0, cp_audit_rows: 1, gallery_stars: 0, gallery_reports: 0, gallery_installs: 0, feedback_objects: 0,
      },
      signIn: 0,
      danaWorkspace: { slate_share_users: 0, slate_live_share_users: 0, slate_viewer_requests: 0, slate_edit_marks: 0, slate_share_views: 0 },
      danaAccount: { cards: 0, overviews: 0 },
    });
  });
});
