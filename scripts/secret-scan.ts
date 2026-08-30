#!/usr/bin/env bun
// Custom secret-pattern scan over two deliberately separate corpora:
//
//   bun scripts/secret-scan.ts            # live/index + reachable history
//   bun scripts/secret-scan.ts --history  # reachable history only
//
// Live/index inspection catches what is about to leave the machine. Historical
// inspection keeps a removed credential from becoming a forgotten credential:
// it walks every locally stored ref and scans each reachable text blob exactly
// once. Neither report writes a matched value to stdout or stderr.
import { join, relative } from 'node:path';
import {
  bytesToText,
  historyObjects,
  isScannableBytes,
  isTextSource,
  listHistoryRefs,
  readHistoryObjects,
  readMatching,
  type HistoryObject,
} from './sources';
export type { HistoryObject, HistoryRefClass } from './sources';

const REPO_ROOT = join(import.meta.dir, '..');

export interface SecretPattern {
  id: string;
  /** Global so a line carrying two secrets reports both. */
  regex: RegExp;
  /** Shapes that match `regex` but cannot be a live credential: env lookups,
   *  documentation placeholders, type declarations. Narrow on purpose — this
   *  is the one place where widening loses real detections. */
  benign?: RegExp;
  message: string;
}

// Build the two literal internal names in parts. The scanner must inspect its
// own historical source too, so spelling a detector's example contiguously here
// would create a circular adjudication whenever this implementation changes.
const CF_INTERNAL_REFERENCE = new RegExp([
  'wiki\\.cfdata\\.org',
  'cloudflare' + '/ew\\b',
  'edge' + 'worker\\b',
  'metrics\\.c\\+\\+',
  'cf-(?:primitives|internal)-dossier',
].join('|'), 'g');

export const PATTERNS: readonly SecretPattern[] = [
  {
    id: 'aws-access-key',
    regex: /AKIA[A-Z0-9]{16}/g,
    message: 'AWS access key id',
  },
  {
    id: 'private-key',
    regex: /-----BEGIN\s+(?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY/g,
    message: 'private key block',
  },
  {
    id: 'jwt',
    regex: /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\./g,
    message: 'JWT with a payload',
  },
  {
    id: 'aig-bearer',
    regex: /cf-aig-authorization.*Bearer\s+[A-Za-z0-9_-]{30,}/g,
    benign: /process\.env\.|<your-/,
    message: 'hardcoded AI Gateway bearer token',
  },
  {
    // A Cloudflare user token has a 48-character URL-safe body. The benign
    // form is anchored to one whole placeholder line: a placeholder beside a
    // value never suppresses that value.
    id: 'cloudflare-user-token',
    regex: /\bcfut_[A-Za-z0-9_-]{48}\b/g,
    benign: /^\s*cfut_<your-[A-Za-z0-9-]+>\s*$/,
    message: 'Cloudflare user API token (revoke and replace it immediately)',
  },
  {
    id: 'secret-assignment',
    regex: /(?:password|secret_key|api_key|api_secret|auth_token|oauth_token)\s*[:=]\s*["'][A-Za-z0-9_/+=-]{8,}["']/gi,
    benign: /process\.env\.|<your-|^\s*(?:type|interface)\s/,
    message: 'hardcoded secret assignment',
  },
  {
    // Kinu is a public repository. Cloudflare-internal research reached this
    // ecosystem once already: ~/Nimbus kept dossiers under a gitignored
    // `docs/research/`, compiled from Cloudflare's internal repository and wiki,
    // and their SECTION CITATIONS still shipped inside a public production
    // constant. A citation is not a secret, but it names internal material and
    // invites reconstruction, so the names are blocked at the same seam as a
    // credential rather than left to reviewer memory.
    id: 'cf-internal-reference',
    regex: CF_INTERNAL_REFERENCE,
    message: 'Cloudflare-internal source reference (public repo — cite the measurement instead)',
  },
  {
    // Kinu's OWN credentials were the one shape this scan did not cover, and
    // they are the shape most likely to leak from this repo: `kinu tokens
    // create` prints the value once, so it gets pasted — into a chat, a CI
    // config, a scratch file. The precedent is already in the ledger: an
    // OpenRouter key pasted in plaintext into a transcript has never been
    // confirmed rotated, and it is tracked as owner-blocked because the paste
    // is unrecoverable once it lands anywhere durable.
    //
    // The access, CLI, and device token prefixes share one shape. Fragments
    // match too, deliberately: eight or more hex characters after a prefix is
    // a finding. A truncated paste after the access-token prefix is still
    // evidence a live token reached a durable file — the 2026-08-18 transcript
    // leak carried one beside two full tokens, and the old `{16,}` floor plus a
    // benign that exempted any LINE containing an ellipsis let it through twice
    // over. An ellipsis is benign only when it elides the whole body directly
    // after the prefix, i.e. prose NAMING the shape rather than quoting a value.
    id: 'kinu-token',
    regex: /\bp(?:ta|tc|dt)_[0-9a-f]{8,}/g,
    benign: /<your-|\bp(?:ta|tc|dt)_(?:\.\.\.|…)/,
    message: 'Kinu access/CLI/device token (rotate it — a printed-once value that reached a file is compromised)',
  },
  {
    // The shapes GITHUB blocks on. Learned the hard way: a push of 96 verified
    // commits was rejected by push protection for a Stripe-shaped literal in
    // `unit-egress-gate.test.ts:43` — a synthetic NEGATIVE CONTROL asserting
    // that a real-shaped secret is NOT mistaken for an egress placeholder —
    // while this scan passed, because it had no Stripe pattern to suppress.
    // Our measured set was strictly narrower than the set that governs us, and
    // the first anyone learned of it was at the push. A remote gate we cannot
    // see is still a gate; mirroring its shapes is what makes a local pass
    // predictive. Prefixes only — high-precision and delimited, never a bare
    // two-character prefix, which would fire on ordinary prose.
    //
    // The remedy it names is deliberately NOT ".secretscanignore". Declaring a
    // fixture satisfies THIS scan and changes nothing about GitHub's, which
    // reads the source text and cannot be given an in-repo exception. So a
    // negative control that must carry a real-looking shape has to assemble it
    // at runtime; the function under test still receives the identical string.
    id: 'provider-secret',
    regex: /\b(?:[sr]k_live_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|sk-ant-[A-Za-z0-9-]{20,}|sk-proj-[A-Za-z0-9_-]{20,})/g,
    benign: /<your-|example|placeholder/,
    message: "third-party provider credential — if this is a deliberate test fixture, ASSEMBLE it at runtime rather than declaring it in .secretscanignore: a declaration satisfies THIS scan, but GitHub push protection reads the source text and will block the push anyway",
  },
  {
    id: 'credentialed-url',
    regex: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^:\s]+:[^@\s]{8,}@/g,
    benign: /<your-|localhost/,
    message: 'connection string with embedded credentials',
  },
];

export interface Finding {
  pattern: string;
  file: string;
  line: number;
  /** The matched text, not the whole line — the line may carry real context. */
  match: string;
  text: string;
}


export function scanText(file: string, text: string, patterns: readonly SecretPattern[] = PATTERNS): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  for (const p of patterns) {
    lines.forEach((line, i) => {
      if (p.benign?.test(line)) return;
      for (const m of line.matchAll(p.regex)) {
        findings.push({ pattern: p.id, file, line: i + 1, match: m[0], text: line.trim() });
      }
    });
  }
  return findings;
}

/** Detector counts without retaining a matched value. Historical reporting is
 * deliberately metadata-only, even in memory after a blob has been decoded. */
export function countDetections(
  text: string,
  patterns: readonly SecretPattern[] = PATTERNS,
): Map<string, number> {
  const counts = new Map<string, number>();
  const lines = text.split('\n');
  for (const pattern of patterns) {
    let count = 0;
    for (const line of lines) {
      if (pattern.benign?.test(line)) continue;
      for (const _ of line.matchAll(pattern.regex)) count += 1;
    }
    if (count > 0) counts.set(pattern.id, count);
  }
  return counts;
}


export const MAX_HISTORY_BLOB_BYTES = 1024 * 1024;
export const REMOVED_CREDENTIAL_BLOB = 'c9e579c076abdaa62188445f7cebce17895062be';

const OBJECT_ID = /^[0-9a-f]{40,64}$/;

export interface HistoryReachability {
  refs: number;
  objects: readonly HistoryObject[];
}

export interface HistoricalFinding {
  detector: string;
  oid: string;
  path: string;
  refClass: string;
  count: number;
}

export interface HistoricalAdjudication {
  oid: string;
  path: string;
  detector: string;
  count: number;
}

export interface HistoryStats {
  refs: number;
  objects: number;
  blobs: number;
  nul: number;
  oversize: number;
  scanned: number;
}

export interface HistoryScanOutcome {
  findings: HistoricalFinding[];
  adjudicated: number;
  stats: HistoryStats;
}

/**
 * The historical fixture corpus at f78a92e6e. Every line is one exact
 * `(blob OID, path, detector, count)` adjudication; none names a directory or a
 * test class. A new historical fixture must earn another exact row rather than
 * widening a suppression.
 */
const CANONICAL_HISTORY_FIXTURES: readonly HistoricalAdjudication[] = parseHistoryAdjudications(`
23078d42daa3fa9728761340fdc96a8ac7369f5c	.secretscanignore	aws-access-key	1
b864abfdc0c9edabeda98b4a1a4d171d46c48955	.secretscanignore	aws-access-key	1
c2deb310ddee38130404206e66a87fd803433cb8	.secretscanignore	aws-access-key	1
23078d42daa3fa9728761340fdc96a8ac7369f5c	.secretscanignore	kinu-token	9
c2deb310ddee38130404206e66a87fd803433cb8	.secretscanignore	kinu-token	9
23078d42daa3fa9728761340fdc96a8ac7369f5c	.secretscanignore	provider-secret	5
8e78aebe6cbb69eec48a56613127824bd584d974	docs/requirements/OWNER-MESSAGES-VERBATIM.md	cf-internal-reference	4
8e78aebe6cbb69eec48a56613127824bd584d974	docs/requirements/OWNER-MESSAGES-VERBATIM.md	kinu-token	1
59e1d91abdc4e74deca3487543eba6bd675036fd	packages/cf-backend/tests/unit-client-error-route.test.ts	kinu-token	2
07de9de07077bdd40b11fe1b742df51ec8099cdb	packages/cf-backend/tests/unit-egress-interception.test.ts	provider-secret	1
1d6310c4969964a0ea8c55c650b895a220a839d4	packages/cf-backend/tests/unit-egress-interception.test.ts	provider-secret	1
242a235db0138031d538a4410bb3e4767bfcfbf4	packages/cf-backend/tests/unit-egress-interception.test.ts	provider-secret	1
439c3cc9b83661ce9bda9d59fd6bd37569809c8d	packages/cf-backend/tests/unit-egress-interception.test.ts	provider-secret	1
4e48ace827aa944c627b07da9a8f35a0185ced9b	packages/cf-backend/tests/unit-egress-interception.test.ts	provider-secret	1
862cf5cae2d3c4bf6832a89f2485a60b7de086d8	packages/cf-backend/tests/unit-egress-interception.test.ts	provider-secret	1
a83ec0ccba3bf37621fe3aa403348cd063e8b680	packages/cf-backend/tests/unit-egress-interception.test.ts	provider-secret	1
bf4f6603bb7a70b5553197129440d422fe335f89	packages/cf-backend/tests/unit-egress-interception.test.ts	provider-secret	1
dc082a4e1c783494d671274cba14e0122b53e493	packages/cf-backend/tests/unit-egress-interception.test.ts	provider-secret	1
fb6cac76a8e64d52588e17187c1aa550445e427e	packages/cf-backend/tests/unit-egress-interception.test.ts	provider-secret	1
52ab326ac6f597bdac544dc57e676203c708fb96	packages/cf-backend/tests/unit-egress-vault.test.ts	provider-secret	1
57a60a65f1fd8ad7ac41969207e66a655de587cb	packages/cf-backend/tests/unit-egress-vault.test.ts	provider-secret	1
7a8e42532d7790a5e07e82caf248b70d9168f458	packages/cf-backend/tests/unit-egress-vault.test.ts	provider-secret	1
9db2bc4ee5076aba2904067bcb0306d4d1ccb1c6	packages/cf-backend/tests/unit-egress-vault.test.ts	provider-secret	1
e5108d8cd4b6fabcaf3af2267bd853306f21fbc7	packages/cf-backend/tests/unit-egress-vault.test.ts	provider-secret	1
f156fd64d3e8e42f7f6a3b3b062515cf18a35ee1	packages/cf-backend/tests/unit-egress-vault.test.ts	provider-secret	1
315aa68d732d8d8e57c72757168797d8779d051d	packages/cf-backend/tests/unit-preview-origin.test.ts	kinu-token	1
41ea873cf12dc164dc3b77b5b94cdb9adbe2b740	packages/cf-backend/tests/unit-preview-origin.test.ts	kinu-token	1
4502b7e2af099664bf27ba5fbf2038ffcbe66c6a	packages/cf-backend/tests/unit-preview-origin.test.ts	kinu-token	1
a3d6503cdeaaf7e1984036a19cf794fbf054e500	packages/cf-backend/tests/unit-preview-origin.test.ts	kinu-token	1
c00bf3dd5f8d86edd456340c76ae9e098e573980	packages/cf-backend/tests/unit-preview-origin.test.ts	kinu-token	1
d68b684089cc8b52e5145d9a1c06d6cad483d158	packages/cf-backend/tests/unit-preview-origin.test.ts	kinu-token	1
d80e9862c1c317fcc08a515e73ae02cafb6c88e1	packages/cf-backend/tests/unit-preview-origin.test.ts	kinu-token	1
e7bcac38f86f0432a2ef02d235f38370ce4f1dd0	packages/cf-backend/tests/unit-preview-origin.test.ts	kinu-token	1
f5e00fe9b095c26df931223d068de0bf023ae170	packages/cf-backend/tests/unit-preview-origin.test.ts	kinu-token	1
01c0a87e7ef2d6891131a3455da4ff2ef4eb98a4	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
0538c51ff8176568d3ef6f70e2ce28f73ec14942	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
05959dde9acfd145070f7566fd5f98c5d2927fca	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
065d3392546871e789f5e512a41342e9e861660c	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
0839ff6e9d1ef86a12bb280493fe6fc734a85956	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
08b34b6813cb9670b99b86cc1aaffcf9916cc73a	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
0a974509133ec9fcabf89eff5da7787c30fbb317	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
0c7e7fe82ee3cc9828d38dd8dbf2f348b83e0875	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
0df204c996c2f23f6711efe4f52b472c47ea75bc	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
0e65e6fbef750fb3bbd5920901fd0ed4ae7744f0	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
0eafa1afdcdbc523e1be841a82ec16123b5f6196	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
0ef28a6ba469fbc6481d203758d48757036883cb	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
11f342d3582bbe8fbebea660275fdb30a81d171b	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
129595ce758c8452a3bab8b2f309c50aee6713f7	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
180afd125f80ca2b656ee7100767ce5ef69fec2d	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
1c1f4811e76e9e67f89ee5347354bf037551c74d	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
1d96c4ca161185f6ceb2ffcb0109e02ce9e26fc3	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
1f17079209fda6ee3c99f26c1b7b4aad127d073e	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
1f21e101909359ab140da61c17ea27e1b7cc60b1	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
220b3dd722d0ad4e9cf4102d0d6fca4a4bf57c69	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
22334c29c7362e0ae9ceda0bb59711472bd74047	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
25eb31e79a3bbc347603bbdb13d7e9024ec05732	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
31a2f02fca27f88bf910ddbb968190b9a1eeef94	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
3312198f764bb2c0d5f23c4d4dc41711c9e814f1	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
34a383d704510877495c69cb39d540a6a2dc71dc	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
3922651af36825dc2cc7c5bba6a080d47b945f74	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
3bf06815c954c9a5a63ec9a45f4adf1882fab5d5	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
3d45f9c863142488a132268a922d994205f3aa1c	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
3f28b1c8e07be7b8575d8c77408c582a75c9626c	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
410ac21be85e9fc4f6a7d85236b81604ea13cca9	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
43cb152659aebe9866132374a6522074aa6d7843	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
45b01d3fe91d0615c3f8166501b639f425edaef4	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
49b6820db04029e843f116389d12673644bedf46	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
4a8366c71d2629a8f6c5383549f5ff973497d07d	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
4a9ffb7d6132b6370299df1dbf0a67e15a9b3740	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
4b1ba6aeade77c0fedcaac1e5a0a5b1bbf1351ce	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
4fd19ce9b22068c2a34717de9a53ff55a90d4b98	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
515d4119205cce9d50a485f6a81c2a74ac0edbdf	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
51f5d717e895a034826bdb7f1baafbc6eeaa2a6f	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
5365e1e202b5cfce8c54a150f7772d0ad8a561e1	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
55b0de7cf2e2ae8fc7e2ecf618585798e5167787	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
55c79fd06f12d601b916f36312fb0a256140802b	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
5735103fae7dee3c40cc12c0fe3b72b2a925a0f5	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
598f282cb47a322c5f00bba2a6c2c6d91fbbb428	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
5ed5cdad119bca42919da3dca6ce4f9bea442c4c	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
61822076d60ba046d0b63b8862b8ae1fba8be791	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
61cbf543a69807b021c6fc1d5ec6ba4721a9eaf6	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
685f19e6227835222ca15e5c260e490ea31c32b3	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
68f12091786b4dec8af91db0bf4a4881bf463888	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
7436a273dedfab48a90d419c08959d535ef3945c	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
76c5c9dc5b6121618594473d1d20413aa9ec47c7	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
76e99580130dec7cdb82b788123d726f03e0c29e	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
7a81484aa82d0fd7f19736096c20a87f32470e93	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
7b54412eb1d4784b16d8fc53d21cd8737570fd70	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
7efcc76508f528f1a6b74cdb28e966ce1401e931	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
7f4f8e5673ac13de52fe3e5b180be0269c52e73c	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
81b6f456f61f2968ffd3d915016b9c8ed1c52e1e	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
8248d7588bddb0b9e749901c65fd0d8978fba196	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
8aba2600b0427a7eb48fd9d36e5fd7fadbb76c1f	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
8b6f31839f59cfc0e13718e5c8ee06dd21c7b601	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
8d18f15a082db89a5fdea7c1e083d6023b3ff9d3	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
925aa6e2253a83a21065fe6539b1668a4735f40c	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
939fa99c6b217d6aae39a1e60e8566010d98cb8d	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
97b0d85134283d8c6e3464863108d402e678e308	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
9bd48dda4777b0b31b0486a91dddb39c1edadeec	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
9cb991ac164bb545e53f32ea77152c6984654b47	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
9e78302acfe61746afcb50215a56c54363d8704f	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
a5116be7895af2f222661b096967821c51a730c3	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
acaaeb94c3998e8dfeaed0cdfa899e74f4c69d4f	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
afe908a73b1c8ed951e7e33aae880510a162d315	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
b601e93a51523853e644832c455492e9a4d3a1e6	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
b63310d11a701268df5d6e8198039031e027f9e5	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
ba7dee0a5be8fb7d58cf2b63d97d3ad3fb9237bb	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
bacdb0755eff17200e8ceeff28a11a564bfe3d07	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
bcb051821137935aa71aea639ff589ed3a6f81e1	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
bfa0b77b95c09ff27e2136c1316da88f1ac2a557	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
c3aa6fa135b224aa6af63e0431890577e4f7d05a	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
c5899edbdedd61ae0124d0a5dc6b9d2957ba4bc2	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
c604aa27f6eec3ce077ded27bdb112e46a095265	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
c659480692c325db52b13089d0a72fae417fd801	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
c7e076dffc8979caa9b8bb559ba6bc243a87fd14	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
c9336759cd136285970ecd20ef491c1ff374a5cd	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
cf55d94f8a0541e193eb13e82dcf3add41e717a8	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
cf6bccf78f2a2431796042dcca04e6f855f749be	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
d2d42e06fb61eb19c2f9266f1a5ad47e11872100	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
d415e7ac8f4d1714c462f04399359c69b62642e1	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
d4c182a8c084ba39fa05fc6c5b9f0826444cb85e	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
d586c22237a888afe89f0ec6fbe163eca6890d81	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
dc5ea648c6c3c5a0c36afd134499e439b0ace78b	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
dde305e6a928958e7ee418ae819649fee8e3ad00	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
e29edb90a96a388c8d8b92fd14dbbcdd5cef15dc	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
e98da4d1a4deaaa16115d3b0f6ea29884412e32e	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
f152301543551cced0017216c395ab3a2f7eb505	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
f5afb1748132fe7a48f6e0941d370fa95235b43b	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
fa591bd3a1c94d90042fa0f47124469d68a46af9	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
fa863de9d6d477518dc0089dc13204fb886e9578	packages/cli-backend/tests/local-session.test.ts	kinu-token	1
0a8fc55545834b38fdb0f722f5516eae58cb903f	packages/cli-backend/tests/model-resolver.test.ts	kinu-token	1
1e0d419b6ba3c7b1ce13860faf7e5bbf56c92655	packages/cli-backend/tests/model-resolver.test.ts	kinu-token	1
2f7a6044ebed62185c54b13666f10df1bf7cf685	packages/cli-backend/tests/model-resolver.test.ts	kinu-token	1
30e0fd8556d7eefb78d37669b752d324872c431e	packages/cli-backend/tests/model-resolver.test.ts	kinu-token	1
3a3eb428a1ba9e47021fe1592b4d070bb5e84795	packages/cli-backend/tests/model-resolver.test.ts	kinu-token	1
3fc2a1666af53c1d6dc82b09b8827cb56bfbf219	packages/cli-backend/tests/model-resolver.test.ts	kinu-token	1
41c97cc52e3e41586e17207b511605d91eca8081	packages/cli-backend/tests/model-resolver.test.ts	kinu-token	1
493f6bc597242efbb4b18b0c3f3d6c397ca2318e	packages/cli-backend/tests/model-resolver.test.ts	kinu-token	1
52dd953eb058abe63362b4b34d0fc654b9d70b28	packages/cli-backend/tests/model-resolver.test.ts	kinu-token	1
5456aaeae1c066c896fe51ac6e438757a5c5cd27	packages/cli-backend/tests/model-resolver.test.ts	kinu-token	1
5a2c312863b171947af077a86a9ee79bbeaaed41	packages/cli-backend/tests/model-resolver.test.ts	kinu-token	1
9e772a756d3eff1b9bd22318305be3a038a7d5e7	packages/cli-backend/tests/model-resolver.test.ts	kinu-token	1
b2599c612cfcfdb2b811f8e0c044ab23bd1c224b	packages/cli-backend/tests/model-resolver.test.ts	kinu-token	1
bfe4c8272320fab7f82e562659aa542604150ac3	packages/cli-backend/tests/model-resolver.test.ts	kinu-token	1
eb90459548ae410c4b9616561958454a1ddfddc1	packages/cli-backend/tests/model-resolver.test.ts	kinu-token	1
003a63dc660503c61b7016665e8cf7054990630d	packages/cli/tests/agent-list.test.ts	kinu-token	2
0aeefe37a6ac796d8474c0d7148fc099ead17d1e	packages/cli/tests/agent-list.test.ts	kinu-token	2
1ba7d7fc1b1e4fa2ce6754815fa7b52209bf3616	packages/cli/tests/agent-list.test.ts	kinu-token	2
3803f29690022476c5f012738a26b0930f8a3bd1	packages/cli/tests/agent-list.test.ts	kinu-token	3
59808b1d358e8bd3ef2105e90e1ca072e1fc3552	packages/cli/tests/agent-list.test.ts	kinu-token	2
75bd3095f07be8ae8bc8cc0df9b9a665198f21b6	packages/cli/tests/agent-list.test.ts	kinu-token	2
953d89bd6c0b3f6323f8b4a8d690785843e52044	packages/cli/tests/agent-list.test.ts	kinu-token	2
aae6c80ca640c1cea9337fbcaa86a37f150325dc	packages/cli/tests/agent-list.test.ts	kinu-token	2
fcc01e4bc7945baeb2b515e1462d1c977d984866	packages/cli/tests/agent-list.test.ts	kinu-token	3
fe3f45b12384f0226ad1bf700c1e1894ecdba8d7	packages/cli/tests/agent-list.test.ts	kinu-token	2
02fefd1c61ae585b3e34aa828ada8ed8aa2eeca1	packages/cli/tests/behavior.test.ts	kinu-token	5
032cb92ef3d28b49f9a402918547a24a55500090	packages/cli/tests/behavior.test.ts	kinu-token	7
0d6f0b9ec1160d1269a4370ddfba921127fc91a6	packages/cli/tests/behavior.test.ts	kinu-token	7
1bb2ad3cc42e642d83e7bee123b018f2da27d274	packages/cli/tests/behavior.test.ts	kinu-token	7
430b327e1536c45dd9dc6934bf310c85337dca64	packages/cli/tests/behavior.test.ts	kinu-token	7
4bc3908f0b3b824913f321aa16b3a39a11775154	packages/cli/tests/behavior.test.ts	kinu-token	7
5031263df4f090ece850f00cbe66707d9dbe00e8	packages/cli/tests/behavior.test.ts	kinu-token	7
6879400e58b70adacb4d01e5b392116c7afc895f	packages/cli/tests/behavior.test.ts	kinu-token	7
6dbb35290e8a218e6e6e2a5f933b530681832422	packages/cli/tests/behavior.test.ts	kinu-token	7
6ecf6455eadae5fde8fb8498899dc35752f9fa4d	packages/cli/tests/behavior.test.ts	kinu-token	7
71188996fc2bdac387505a9043389d3e68a52943	packages/cli/tests/behavior.test.ts	kinu-token	5
7714a9fb7d112ab5d249582dc73f72027f8a8849	packages/cli/tests/behavior.test.ts	kinu-token	7
7a0f4b144cf618263a590244ba794ad9a4cbe717	packages/cli/tests/behavior.test.ts	kinu-token	7
837a24aeb04ce533903368f38e93e3c87b7657f5	packages/cli/tests/behavior.test.ts	kinu-token	6
84a364cc1b60aaba1eb6fdbdfd3081e325a2ea93	packages/cli/tests/behavior.test.ts	kinu-token	7
99892d40c2a3ded9dcb000e453450f090190918f	packages/cli/tests/behavior.test.ts	kinu-token	7
a5d317abf05f6ca9c45a6dc443947eda3cb2be61	packages/cli/tests/behavior.test.ts	kinu-token	7
a8e04d269a9fe1e5bbba7d638bc2add69dad44fb	packages/cli/tests/behavior.test.ts	kinu-token	7
b101b44c61f8d8bdf7b2fba9fbdb669af3d967b7	packages/cli/tests/behavior.test.ts	kinu-token	7
b2bfe5e8138c0e328de1c3db74f79049b0f01dd8	packages/cli/tests/behavior.test.ts	kinu-token	3
b4cdd4295845c8fff8d2399d53a46a3072ff9df0	packages/cli/tests/behavior.test.ts	kinu-token	5
b9d3e96ca2817d87fc9b218f95940d30d5bc682e	packages/cli/tests/behavior.test.ts	kinu-token	7
ba6f9caf920c71615d4c441d093fc26f98241f0c	packages/cli/tests/behavior.test.ts	kinu-token	7
be04cee98ea84f462a93bf4a857ec883535cf424	packages/cli/tests/behavior.test.ts	kinu-token	5
be1482e0ab704d219cba9314ae0aea92e2a0d71c	packages/cli/tests/behavior.test.ts	kinu-token	7
bf9b09c1fefca277c0377bdf8cc5e355fa94eb66	packages/cli/tests/behavior.test.ts	kinu-token	6
bfde42d7c7e0722458dc61757bacc910882a6486	packages/cli/tests/behavior.test.ts	kinu-token	7
ccf92bf50fc1280b571d433986231e969de4b7bd	packages/cli/tests/behavior.test.ts	kinu-token	7
fb43ba720f42805efe30755ec87b4c06d6c6ddb5	packages/cli/tests/behavior.test.ts	kinu-token	5
fccc2b9393e0f3106fb204dc4a88dc4a75cc364b	packages/cli/tests/behavior.test.ts	kinu-token	7
0227a2d014889f88af52bc21521a535e66df2f4b	packages/cli/tests/config.test.ts	kinu-token	1
1252c599a662fc7b79aae37e054690810a9c7871	packages/cli/tests/config.test.ts	kinu-token	1
175ee31429a6b66fd1bf6d9ca74d14c94e656823	packages/cli/tests/config.test.ts	kinu-token	1
192aef9ec109ca1de789f1e2394a2328cddb9ec4	packages/cli/tests/config.test.ts	kinu-token	1
21aabad47fab4740d46962a8674c4dfdfcb5eee7	packages/cli/tests/config.test.ts	kinu-token	1
520b66854d107a20d9b1e9aec887bc8aec7b45d9	packages/cli/tests/config.test.ts	kinu-token	1
65a8569968a88568bcce81daeadaca83e441f9d6	packages/cli/tests/config.test.ts	kinu-token	1
75709a230b6c0e14fbf4c3e49fb840dd66431f4d	packages/cli/tests/config.test.ts	kinu-token	1
7751d06aa6866b8bd02592469d261fb018d44b79	packages/cli/tests/config.test.ts	kinu-token	1
8d6e1be45f88a859b6282cdb480f36dc18be6bac	packages/cli/tests/config.test.ts	kinu-token	1
d3da5294e8677862be1e31e2a043003debd159a2	packages/cli/tests/config.test.ts	kinu-token	1
d465dbd25a3040009555b012611987a10c3107fb	packages/cli/tests/config.test.ts	kinu-token	1
f8b54e7a07d92e2f131f78c5b2de89f158f788f3	packages/cli/tests/config.test.ts	kinu-token	1
fc6a88630eb3c78494c55babf8e71f7bf5f90d40	packages/cli/tests/config.test.ts	kinu-token	1
04a41bb0976ade44f9a53a98393f4c8e048dafed	packages/cli/tests/debug.test.ts	aws-access-key	1
0c334f32c413fa73ad639f5f303f5ef478040234	packages/cli/tests/debug.test.ts	aws-access-key	1
1bad80083e55e1c53c25cad42ad4a6be6f4f19ab	packages/cli/tests/debug.test.ts	aws-access-key	1
205c26859ca558ae7b7956d30a0aacaea5555d7f	packages/cli/tests/debug.test.ts	aws-access-key	1
265800a0c1d997f2428bd41fc9ceb3a2be8d7869	packages/cli/tests/debug.test.ts	aws-access-key	1
268d3921ad377e8797ae4cbf142fa3d8066ee2f3	packages/cli/tests/debug.test.ts	aws-access-key	1
30648e4037514ecf0c461dcb52c1a6bbb14f495f	packages/cli/tests/debug.test.ts	aws-access-key	1
41b4cb1f564a3f72e68d85173575f4304fbf14ad	packages/cli/tests/debug.test.ts	aws-access-key	1
41e7e6ec8af55161babf9b17b5e601dfc73b35c4	packages/cli/tests/debug.test.ts	aws-access-key	1
59d8f652f8c43603b099672dd0a51da38629c3b6	packages/cli/tests/debug.test.ts	aws-access-key	1
5a4156106497f7ca7c025854a9b5d4cd52912172	packages/cli/tests/debug.test.ts	aws-access-key	1
8f302e974c27caf3d3bbb92adff0bf74b9f46168	packages/cli/tests/debug.test.ts	aws-access-key	1
9166d270226933154cb7b4ffb51e07cd51fc120d	packages/cli/tests/debug.test.ts	aws-access-key	1
9296195f2fb8be6ac613173ec02a4ffa4474dabf	packages/cli/tests/debug.test.ts	aws-access-key	1
94b90fbce94041955c772cc03d487cef40237f6d	packages/cli/tests/debug.test.ts	aws-access-key	1
c12bc8cbf279b1759cdf1485738579994f9f0215	packages/cli/tests/debug.test.ts	aws-access-key	1
c5cd931e884a3539a953a79bcba2114b63159214	packages/cli/tests/debug.test.ts	aws-access-key	1
d6561015758c1e06d672bc756149ffdfeaddca8c	packages/cli/tests/debug.test.ts	aws-access-key	1
f0e5d4f7005c8a634df32a5beac488dfb5f88b87	packages/cli/tests/debug.test.ts	aws-access-key	1
f8be093abf7387fa25f5860324b49151e379755a	packages/cli/tests/debug.test.ts	aws-access-key	1
fee60988b75b3528690474b283b69c7c8e3921be	packages/cli/tests/debug.test.ts	aws-access-key	1
04a41bb0976ade44f9a53a98393f4c8e048dafed	packages/cli/tests/debug.test.ts	provider-secret	1
0c334f32c413fa73ad639f5f303f5ef478040234	packages/cli/tests/debug.test.ts	provider-secret	1
1bad80083e55e1c53c25cad42ad4a6be6f4f19ab	packages/cli/tests/debug.test.ts	provider-secret	1
205c26859ca558ae7b7956d30a0aacaea5555d7f	packages/cli/tests/debug.test.ts	provider-secret	1
265800a0c1d997f2428bd41fc9ceb3a2be8d7869	packages/cli/tests/debug.test.ts	provider-secret	1
268d3921ad377e8797ae4cbf142fa3d8066ee2f3	packages/cli/tests/debug.test.ts	provider-secret	1
30648e4037514ecf0c461dcb52c1a6bbb14f495f	packages/cli/tests/debug.test.ts	provider-secret	1
41b4cb1f564a3f72e68d85173575f4304fbf14ad	packages/cli/tests/debug.test.ts	provider-secret	1
41e7e6ec8af55161babf9b17b5e601dfc73b35c4	packages/cli/tests/debug.test.ts	provider-secret	1
59d8f652f8c43603b099672dd0a51da38629c3b6	packages/cli/tests/debug.test.ts	provider-secret	1
5a4156106497f7ca7c025854a9b5d4cd52912172	packages/cli/tests/debug.test.ts	provider-secret	1
8f302e974c27caf3d3bbb92adff0bf74b9f46168	packages/cli/tests/debug.test.ts	provider-secret	1
9166d270226933154cb7b4ffb51e07cd51fc120d	packages/cli/tests/debug.test.ts	provider-secret	1
9296195f2fb8be6ac613173ec02a4ffa4474dabf	packages/cli/tests/debug.test.ts	provider-secret	1
94b90fbce94041955c772cc03d487cef40237f6d	packages/cli/tests/debug.test.ts	provider-secret	1
c12bc8cbf279b1759cdf1485738579994f9f0215	packages/cli/tests/debug.test.ts	provider-secret	1
c5cd931e884a3539a953a79bcba2114b63159214	packages/cli/tests/debug.test.ts	provider-secret	1
d6561015758c1e06d672bc756149ffdfeaddca8c	packages/cli/tests/debug.test.ts	provider-secret	1
f0e5d4f7005c8a634df32a5beac488dfb5f88b87	packages/cli/tests/debug.test.ts	provider-secret	1
f8be093abf7387fa25f5860324b49151e379755a	packages/cli/tests/debug.test.ts	provider-secret	1
fee60988b75b3528690474b283b69c7c8e3921be	packages/cli/tests/debug.test.ts	provider-secret	1
119cba33f20e059986031bd3d983046ec7a7c948	packages/cli/tests/device-connect.test.ts	kinu-token	1
22b3126a9801030395102f79c333f64bcf0c1679	packages/cli/tests/device-connect.test.ts	kinu-token	1
3d93d841183c9d8d2d440102f87d3cc0bfce5826	packages/cli/tests/device-connect.test.ts	kinu-token	1
4542ccb739fe4ddcb892950f68b922460f977629	packages/cli/tests/device-connect.test.ts	kinu-token	1
45739f6352e9d008d9214e53f332e6144496fec1	packages/cli/tests/device-connect.test.ts	kinu-token	1
48a589bd17baef5a1a1a551e4e54a3c17746020e	packages/cli/tests/device-connect.test.ts	kinu-token	1
8b25caee64dff9faaa31991129bbef67abf47297	packages/cli/tests/device-connect.test.ts	kinu-token	1
a8eb9870447ceacc07aad024c9db856623108e31	packages/cli/tests/device-connect.test.ts	kinu-token	1
ad53303b4d4614bdd6c3fcd0a19be70fd8afce20	packages/cli/tests/device-connect.test.ts	kinu-token	1
bc9e49df331cb5868c5df6f9d69a89890de90b93	packages/cli/tests/device-connect.test.ts	kinu-token	1
e0bf62846ac3d2544c2b4143e1e6c1dda50dd52a	packages/cli/tests/device-connect.test.ts	kinu-token	1
fb77f558398e5241fa54becde10d37787829d245	packages/cli/tests/device-connect.test.ts	kinu-token	1
095108e18ff7627d1fb80cf8ede45b2ad6b98b48	packages/cli/tests/local-model-resolver.test.ts	kinu-token	1
4258c5cbe3110c5f8e3593f7150dcbeda903542d	packages/cli/tests/local-model-resolver.test.ts	kinu-token	1
5c3ec0531d3fa6af32526d74dbf485eef1f55e98	packages/cli/tests/local-model-resolver.test.ts	kinu-token	1
7687377786f9d3fa376df0fa0a309a94ed64df64	packages/cli/tests/local-model-resolver.test.ts	kinu-token	1
b480bce24b67a8c8e3839622e24b7f14116ff37c	packages/cli/tests/local-model-resolver.test.ts	kinu-token	1
ba368d897db7901908e74ad0a0e1c78a1cb9d881	packages/cli/tests/local-model-resolver.test.ts	kinu-token	1
dc3ebc09ebdbbca578c30c8800a209b1dc6702e6	packages/cli/tests/local-model-resolver.test.ts	kinu-token	1
f097c6a3f5bbf37f257c7958edd836b0493c0f72	packages/cli/tests/local-model-resolver.test.ts	kinu-token	1
2a72c8069fc6d5a2fdf73035d5be1a15a62bba8d	packages/cli/tests/setup-default-provider.test.ts	kinu-token	1
6d54dfcd5c96f42832dd8a4b5ef6929a8a9cd015	packages/cli/tests/setup-default-provider.test.ts	kinu-token	1
a841de8d3348630463dbd1bf30bb20d0b1916b08	packages/cli/tests/setup-default-provider.test.ts	kinu-token	1
b11243773ad0c7d394be1982eb5732058f743c83	packages/cli/tests/setup-default-provider.test.ts	kinu-token	1
ccd0ef3f55b8fbc16c8eee694aa22fd151c8daf2	packages/cli/tests/setup-default-provider.test.ts	kinu-token	1
2d3c14af648385a3dbbc00ba036018b2e6756680	packages/cli/tests/tui.test.tsx	kinu-token	1
3a8a19aa63e07f74f582cbfc6821d8c6eab8ade4	packages/cli/tests/tui.test.tsx	kinu-token	1
99c2a4a583f401bb298c570084e6ce7cff9db34a	packages/cli/tests/tui.test.tsx	kinu-token	1
49a56bfd616d560a29816843f9aa0ae93bc1ebc1	packages/core/tests/unit-egress-gate.test.ts	provider-secret	2
87d10cb8b012ba3bf4b08987eac8b2ca897adc45	packages/core/tests/unit-egress-gate.test.ts	provider-secret	2
55d4c680789405c3f68a8c47b7f482513bbbcff1	scripts/secret-scan.test.ts	aig-bearer	1
55d4c680789405c3f68a8c47b7f482513bbbcff1	scripts/secret-scan.test.ts	aws-access-key	7
55d4c680789405c3f68a8c47b7f482513bbbcff1	scripts/secret-scan.test.ts	credentialed-url	1
55d4c680789405c3f68a8c47b7f482513bbbcff1	scripts/secret-scan.test.ts	jwt	1
55d4c680789405c3f68a8c47b7f482513bbbcff1	scripts/secret-scan.test.ts	private-key	2
55d4c680789405c3f68a8c47b7f482513bbbcff1	scripts/secret-scan.test.ts	secret-assignment	4
0024c8a45c7d0d3ae43e070f15b20ed13603d6bb	scripts/secret-scan.ts	cf-internal-reference	1
1768b546b8156af4dd0a1aa269c376a7aa2e8d5d	scripts/secret-scan.ts	cf-internal-reference	1
1af153fe020ddd9a8f46280d4d0a858c313b2749	scripts/secret-scan.ts	cf-internal-reference	1
65dd4c1c9dffba3d17f01926bcd6855134f3d6a1	scripts/secret-scan.ts	cf-internal-reference	1
83c338ede188cc5f6b2507e5e240de2da86c4609	scripts/secret-scan.ts	cf-internal-reference	1
8a19cba1922a104bb1989165d48cc0730f177f3b	scripts/secret-scan.ts	cf-internal-reference	1
b047f70b349f1c3baa088967218d0fcc98d8641b	scripts/secret-scan.ts	cf-internal-reference	1
cd8159648350da02c94ecbb738f09a2f94da1978	scripts/secret-scan.ts	cf-internal-reference	1
d038c29fa6b65d22ca89ceb8b228998e9a986555	scripts/secret-scan.ts	cf-internal-reference	1
e72e77732b4dc44c26ef8bfcd5c0c1eecbe92ae4	scripts/secret-scan.ts	cf-internal-reference	1
f4a3c293c874d28edab9b4f73c11b804c028e291	scripts/secret-scan.ts	cf-internal-reference	1
f64444e25b726655320ba32c1d06857f4e733419	scripts/secret-scan.ts	cf-internal-reference	1
0024c8a45c7d0d3ae43e070f15b20ed13603d6bb	scripts/secret-scan.ts	kinu-token	1
1af153fe020ddd9a8f46280d4d0a858c313b2749	scripts/secret-scan.ts	kinu-token	1
cd8159648350da02c94ecbb738f09a2f94da1978	scripts/secret-scan.ts	kinu-token	1
f4a3c293c874d28edab9b4f73c11b804c028e291	scripts/secret-scan.ts	kinu-token	1
f64444e25b726655320ba32c1d06857f4e733419	scripts/secret-scan.ts	kinu-token	1
`);

/**
 * Six non-fixture historical false positives reviewed by security: four old
 * Gallery samples and two former workflow assignments. The tuple is still the
 * whole exception; the review does not exempt their paths going forward.
 */
const SECURITY_REVIEWED_HISTORY_FALSE_POSITIVES: readonly HistoricalAdjudication[] = parseHistoryAdjudications(`
23029e8f8ec7a414fd34759bd8a05cee6d7ddecf	.github/workflows/security-scan.yml	secret-assignment	2
3402448079a6183a404667cebe5f2ffc5b34a787	.github/workflows/security-scan.yml	secret-assignment	2
1a03fe11b23638ab96cc934f6710ad7577da65fc	packages/cf-backend/src/gallery.tsx	provider-secret	1
2b6cb89f2216ac17f51dae6ddfea3c362b95c8db	packages/cf-backend/src/gallery.tsx	provider-secret	1
97087c3e2ea306b0071917e55e3eafe723ec384b	packages/cf-backend/src/gallery.tsx	provider-secret	1
eac626dfe7e701728705f277cd486b52227efaa9	packages/cf-backend/src/gallery.tsx	provider-secret	1
`);

export const HISTORY_ADJUDICATIONS: readonly HistoricalAdjudication[] = [
  ...CANONICAL_HISTORY_FIXTURES,
  ...SECURITY_REVIEWED_HISTORY_FALSE_POSITIVES,
];

function parseHistoryAdjudications(serialized: string): HistoricalAdjudication[] {
  return serialized.trim().split('\n').map((line) => {
    const fields = line.split('\t');
    const [oid, path, detector, count] = fields;
    if (fields.length !== 4 || oid === undefined || path === undefined || detector === undefined
      || count === undefined || !OBJECT_ID.test(oid) || !/^[1-9]\d*$/.test(count)) {
      throw new Error('history secret scan: malformed exact adjudication');
    }
    return { oid, path, detector, count: Number(count) };
  });
}

function historyAdjudicationKey({ oid, path, detector, count }: HistoricalAdjudication): string {
  return `${oid}\0${path}\0${detector}\0${String(count)}`;
}

/** Exact tuple matching is intentionally independent of ref class: a blob may
 * move from a branch to a tag without turning a reviewed object into a new
 * value, while a path, detector, or count change immediately re-arms it. */
export function adjudicateHistory(
  findings: readonly HistoricalFinding[],
  adjudications: readonly HistoricalAdjudication[] = HISTORY_ADJUDICATIONS,
): Pick<HistoryScanOutcome, 'findings' | 'adjudicated'> {
  const allowed = new Set<string>();
  for (const adjudication of adjudications) {
    const key = historyAdjudicationKey(adjudication);
    if (allowed.has(key)) throw new Error('history secret scan: duplicate exact adjudication');
    allowed.add(key);
  }
  const kept = findings.filter((finding) => !allowed.has(historyAdjudicationKey(finding)));
  return { findings: kept, adjudicated: findings.length - kept.length };
}

/** Every object/path association reachable from every locally stored ref. */
export function enumerateHistoricalReachability(repoRoot = REPO_ROOT): HistoryReachability {
  const refs = listHistoryRefs(repoRoot);
  const objects = historyObjects(repoRoot, refs);
  if (objects.some((object) => object.oid === REMOVED_CREDENTIAL_BLOB)) {
    throw new Error(`history secret scan: removed credential blob ${REMOVED_CREDENTIAL_BLOB} is reachable`);
  }
  return { refs: refs.length, objects };
}

/** Scan every locally reachable blob. NUL-bearing blobs and blobs above the
 * explicit size cap are counted but intentionally not decoded; the green
 * denominator makes those blind spots visible rather than silently shrinking
 * the corpus. */
export async function scanHistory(options: {
  repoRoot?: string;
  adjudications?: readonly HistoricalAdjudication[];
  maxBlobBytes?: number;
} = {}): Promise<HistoryScanOutcome> {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const maxBlobBytes = options.maxBlobBytes ?? MAX_HISTORY_BLOB_BYTES;
  if (!Number.isSafeInteger(maxBlobBytes) || maxBlobBytes < 0) {
    throw new Error('history secret scan: invalid blob size cap');
  }
  const reachability = enumerateHistoricalReachability(repoRoot);
  const stats: HistoryStats = {
    refs: reachability.refs,
    objects: 0,
    blobs: 0,
    nul: 0,
    oversize: 0,
    scanned: 0,
  };
  const raw: HistoricalFinding[] = [];
  await readHistoryObjects(repoRoot, reachability.objects, maxBlobBytes, (object, blob) => {
    stats.objects += 1;
    if (blob.type !== 'blob') return;
    stats.blobs += 1;
    if (blob.size > maxBlobBytes) {
      stats.oversize += 1;
      return;
    }
    if (blob.bytes === undefined) {
      throw new Error('history secret scan: blob content was not returned below its size cap');
    }
    if (!isScannableBytes(blob.bytes)) {
      stats.nul += 1;
      return;
    }
    stats.scanned += 1;
    for (const [detector, count] of countDetections(bytesToText(blob.bytes))) {
      raw.push({
        detector,
        oid: object.oid,
        path: object.path === '' ? '<unnamed>' : object.path,
        refClass: object.refClasses.join(','),
        count,
      });
    }
  });
  raw.sort((left, right) => left.detector.localeCompare(right.detector)
    || left.oid.localeCompare(right.oid)
    || left.path.localeCompare(right.path)
    || left.refClass.localeCompare(right.refClass));
  return { ...adjudicateHistory(raw, options.adjudications), stats };
}

export interface LiveScanResult {
  findings: Finding[];
  corpusSize: number;
}

/** The live/index scan has no suppression plane. Deliberate fixtures assemble
 * their secret-shaped bytes at runtime, so every source byte stays governed. */
export function scanLiveIndex(): LiveScanResult {
  const self = relative(REPO_ROOT, import.meta.path);
  const corpus = readMatching((file) => isTextSource(file) && file !== self);
  const findings: Finding[] = [];
  for (const [file, text] of corpus) findings.push(...scanText(file, text));
  return { findings, corpusSize: corpus.size };
}

function printablePath(path: string): string {
  return JSON.stringify(path);
}

function reportLive(result: LiveScanResult): boolean {
  for (const finding of result.findings) {
    console.error(`::error::detector=${finding.pattern} path=${printablePath(finding.file)} ref=live-index`);
  }
  if (result.findings.length > 0) {
    console.error(`Secret live/index scan FAILED — ${result.findings.length} finding(s).`);
    console.error('Deliberate fixtures must assemble secret-shaped bytes at runtime; source suppressions are not supported.');
  } else {
    console.log(`Secret live/index scan passed — ${PATTERNS.length} patterns over ${result.corpusSize} tracked or untracked text files.`);
  }
  return result.findings.length > 0;
}

function reportHistory(result: HistoryScanOutcome): boolean {
  for (const finding of result.findings) {
    console.error(`::error::detector=${finding.detector} oid=${finding.oid} path=${printablePath(finding.path)} ref=${finding.refClass} count=${finding.count}`);
  }
  const { stats } = result;
  console.log(
    `Historical secret scan ${result.findings.length === 0 ? 'passed' : 'FAILED'} — refs=${stats.refs} objects=${stats.objects} blobs=${stats.blobs} nul=${stats.nul} oversize=${stats.oversize} scanned=${stats.scanned} adjudicated=${result.adjudicated}.`,
  );
  return result.findings.length > 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--history')) {
    console.error('Usage: bun scripts/secret-scan.ts [--history]');
    process.exitCode = 1;
    return;
  }
  let failed = false;
  if (args[0] !== '--history') failed = reportLive(scanLiveIndex());
  failed = reportHistory(await scanHistory()) || failed;
  if (failed) process.exitCode = 1;
}

if (import.meta.main) {
  void main().catch(() => {
    // Do not surface a tool error: a credential-shaped value is allowed to be
    // present only in the stream we just chose not to report.
    console.error('Secret scan FAILED — unable to inspect the required corpus.');
    process.exitCode = 1;
  });
}
