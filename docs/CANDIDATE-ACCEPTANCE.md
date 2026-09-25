# Candidate acceptance: what the platform allows

I accepted this protection in OWNER-MESSAGES m1099 on 2026-09-12: "move the trajectory family onto the deploy path before publish, so an agent that stops acting correctly blocks the upload rather than being discovered after it". It remains unmet.

Before `98be0b59b`, the pre-publish tier called production. The candidate had not been uploaded, so a failing old build could block the build carrying its repair. That commit moved trajectory after publication. The tier now measures the right build, and the protection I accepted is gone.

## Why version previews cannot close the gap

Cloudflare's [Preview URLs documentation](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/#limitations), updated 2026-08-28 and read 2026-09-13, states: "Preview URLs are not generated for Workers that implement a Durable Object, including Containers and Sandbox Workers." Kinu implements all three. Enabling `preview_urls` cannot remove that platform limitation.

The [Containers deployment guide](https://developers.cloudflare.com/containers/guides/deploy/#before-production), also updated 2026-08-28, says `versions upload` uploads Worker code only. It does not publish an image or roll out containers.

## What a Durable Object version means

Cloudflare's [With Durable Objects](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/) page, updated 2026-07-15, assigns each object a version from the deployment percentages. All requests to that object use that version until another deployment changes its assignment.

This is not a pin a caller can select. [Worker version affinity](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/version-affinity/) uses `Cloudflare-Workers-Version-Key`, and Cloudflare says "you do not choose which version a key maps to". Worker overrides do not prove which version a Durable Object runs.

`ActorAgent.installedBuildIdentity()` already reads `CF_VERSION_METADATA.id` inside the object and records it in turn claims. The tier could use it to verify a selected workspace's version, but does not assert it today. `/api/health` reads Worker assets, not a Durable Object.

## The decision still needed

A. Keep post-publish acceptance. All production traffic is exposed while the tier runs. A red leaves that build live. The latest two `release-*/deploy.log` files, `b84eb4550` and `9a88c6f52`, stopped before upload; neither measured trajectory. The last completed deployed run in `/tmp/kinu-deploy11.log`, build `98be0b59b`, took 1,487 seconds (24m47s), with five live cases failing. That is a historical measurement, not a promised duration.

B. Build gradual acceptance. Allocate a small percentage to the candidate. Prove the tier's eval workspaces received that version. Then promote on green or roll back on red. That percentage of traffic and object assignments is exposed during acceptance. This is not zero-exposure protection. Candidate-workspace selection and version assertions, rollback, and deploy-contract red/green tests do not exist yet. A mechanism that forces only eval objects onto the candidate is undocumented and unproven. Shared UserDO and Sandbox versions also need checking.

Neither option is built. I need to choose the exposure policy before the pipeline changes.
