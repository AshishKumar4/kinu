/**
 * @vitest-environment node
 */
import { env } from 'cloudflare:workers';
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

    // Dana's card reaches Priya's account on its own job, which Dana's account's alarm runs.
    for (let runs = 0; (await account(priya.userId).accountCensus()).user_share_cards === 0; runs += 1) {
      if (runs === 5) throw new Error("Dana's card never reached Priya");
      await account(dana).runDueWork();
    }

    // What a Drive tenant physically keeps: its user object's rows and keys, and every base shard's.
    const drive = async (tenant: string) => {
      const names = await account(dana).driveNames(tenant);
      const shards = await Promise.all(names.shards.map(async (shard) => env.CENSUS_DRIVE_SHARD.get(env.CENSUS_DRIVE_SHARD.idFromName(shard)).storageRows()));
      const user = await env.CENSUS_DRIVE_USER.get(env.CENSUS_DRIVE_USER.idFromName(names.user)).storageRows();

      return { user, shards: shards.reduce((sum, rows) => sum + rows, 0) };
    };

    // A tenant that never wrote, as an emptied one must read: its objects' own schema, and nothing of anyone's.
    const pristine = await drive('census-pristine');

    // Read from Dana's account where a read would make Priya's again.
    const census = async () => ({
      account: await account(priya.userId).accountCensus(),
      mailbox: await mailbox.mailCensus(priya.userId),
      mailName: await name.lookup(),
      drive: await drive(priya.userId),
      previewKeys: await account(dana).previewKeys('priya-notes'),
      controlPlane: await control().controlCensus(priya),
      signIn: await account('kinu:builtin-accounts').signInCensus(priya),
      signInRows: await account('kinu:builtin-accounts').signInRows(priya),
      danaWorkspace: await workspace('northwind-api').shareCensus(priya),
      danaAccount: await account(dana).sentTo(priya),
    });

    const before = await census();
    console.log(`census before: ${JSON.stringify(before)}`);

    expect(before).toMatchObject({
      account: { user_workspaces: 1, user_devices: 1, user_credentials: 1, user_share_cards: 1, user_profile: 1 },
      mailbox: { mail_box: 1, mail_messages: 1, mail_attachments: 1 },
      mailName: { label: 'priya', user_id: priya.userId },
      previewKeys: 1,
      controlPlane: { cp_users: 1, cp_workspaces: 1, cp_feedback: 2, cp_audit_naming: 1, gallery_stars: 1, gallery_installs: 1, feedback_objects: 1 },
      signIn: 1,
      danaWorkspace: { slate_share_users: 2, slate_share_users_revoked: 0, slate_viewer_requests: 0, slate_edit_marks: 1 },
      danaAccount: { cards: 1, overviews: 1 },
    });
    expect(before.mailbox['r2_objects']).toBeGreaterThan(0);
    expect(before.drive.user).toBeGreaterThan(pristine.user);
    expect(before.drive.shards).toBeGreaterThan(pristine.shards);
    expect(before.signInRows).toBeGreaterThan(0);

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

    // Her address routes nowhere, and no one can take it (docs/MAIL.md §11): Email Routing's mail to it is refused.
    expect(await account(dana).mailTo('priya@kinu.run', MIME)).toHaveLength(1);

    const claimed = async (userId: string) => {
      try {
        await name.claim('priya', userId);

        return 'claimed';
      } catch (cause) {
        return renderThrownChain({ cause });
      }
    };

    expect([await claimed(dana), await claimed(priya.userId)]).toEqual([expect.stringContaining('is taken'), expect.stringContaining('is taken')]);

    // A push from a workspace still naming her, as one cached before the deletion would send: her account keeps no
    // card, it answers that it was deleted, and Dana's account forgets her again (owner decision, 2026-10-20).
    expect(await account(priya.userId).deletedAt()).toEqual(expect.any(Number));
    await account(dana).pushStale(priya);

    for (let runs = 0; runs < 3; runs += 1) await account(dana).runDueWork();
    expect({ cards: (await account(priya.userId).accountCensus()).user_share_cards, dana: await account(dana).sentTo(priya) })
      .toEqual({ cards: 0, dana: { cards: 0, overviews: 0 } });

    expect(after).toMatchObject({
      // Retired: kept, owned by no one (docs/MAIL.md §11).
      mailName: { label: 'priya', user_id: '' },
      drive: pristine,
      previewKeys: 0,
      controlPlane: {
        cp_users: 0, cp_workspaces: 0, cp_feedback: 0, cp_audit_naming: 0, cp_audit_rows: 1, gallery_stars: 0, gallery_installs: 0, feedback_objects: 0,
      },
      signIn: 0,
      signInRows: 0,
      danaWorkspace: { slate_share_users: 0, slate_share_users_revoked: 0, slate_viewer_requests: 0, slate_edit_marks: 0, slate_share_views: 0 },
      danaAccount: { cards: 0, overviews: 0 },
    });
  });

  // Review of the account deletion, 2026-10-20: a delivery mid-write when the box was deleted wrote its bytes after the
  // sweep. The mailbox's bucket holds one write until this test releases it: the box's own R2 seam, nothing inside it.
  // Its own account, so nothing of the first case's is in its way: Priya's address at her own domain.
  it('a delivery mid-write when the account is deleted lands nothing after the sweep', async () => {
    const [userId = ''] = await account('census-ids').accountsOf(['priya@raman.dev']);
    const priya = { userId, email: 'priya@raman.dev' };
    const mailbox = env.CENSUS_MAILBOX.get(env.CENSUS_MAILBOX.idFromName(priya.userId));
    const name = env.CENSUS_MAILNAME.get(env.CENSUS_MAILNAME.idFromName('praman'));
    const recipient = parseMailRecipient('praman@kinu.run', 'kinu.run');

    if (recipient === null) throw new Error('praman@kinu.run is no Kinu address');

    await account(priya.userId).seedProfile(priya, 'Priya Raman');
    await name.claim('praman', priya.userId);
    await mailbox.open({ userId: priya.userId, email: priya.email, username: 'praman', assistant: null });

    // Each answer however it ends: the account's object aborts as its delete ends, which its caller reads as an error.
    const ended = async (work: Promise<unknown>): Promise<string> => {
      try {
        await work;

        return 'ok';
      } catch (cause) {
        return renderThrownChain({ cause });
      }
    };

    await mailbox.holdNextWrite();
    const delivering = ended(mailbox.deliver({ raw: new TextEncoder().encode(MIME), envelopeFrom: 'dana@northwind.io', recipient }));

    await mailbox.writeHeld();
    const retired = name.whenRetired();
    const deleting = ended(account(priya.userId).deleteThis());

    // The box has begun its delete: its names go first. The held write is let go only now.
    await retired;
    await mailbox.releaseWrite();
    await Promise.all([delivering, deleting]);
    const left = await mailbox.mailCensus(priya.userId);

    for (const [table, rows] of Object.entries(left)) expect({ table, rows }).toEqual({ table, rows: 0 });
  });
});
