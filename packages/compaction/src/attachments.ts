
import type { Attachment, AttachmentPolicy } from '@better-compact/core';
import {
  attachmentBytes, formatPath, mediaImage, mediaTokens, storeAttachment, SPILL_DIRS, type PathPlanes, type Storage,
} from '@kinu.run/core';
import { carriedMedia, withoutMedia, type CarriedMedia } from './codec';

export interface AttachmentDeps {
  readonly files: () => { readonly storage: Pick<Storage, 'vfs' | 'home'>; readonly planes: PathPlanes };
}

const KEEP_RECENT_IMAGES = 2;

/**
 * Priced for the model serving the request. The key names the policy alone: a plan belongs to the history, so any
 * serving model replays it and one with less room folds further on top (owner, 2026-10-07).
 */
export function kinuAttachments(deps: AttachmentDeps, model: string): AttachmentPolicy {
  return {
    key: `recent:${KEEP_RECENT_IMAGES}`,
    keepRecentImages: KEEP_RECENT_IMAGES,
    list: (item) => carriedMedia(item).flatMap((media) => {
      const attachment = attachmentOf(media);

      return attachment === null ? [] : [attachment];
    }),
    estimateTokens: (attachment, item) => {
      const media = carriedMedia(item).find((carried) => carried.id === attachment.id);

      return media === undefined ? undefined : mediaTokens(model, media);
    },
    replace: (item, attachment, text) => withoutMedia(item, attachment.id, text),
    store: async (attachment, item) => {
      const media = carriedMedia(item).find((carried) => carried.id === attachment.id);
      const bytes = media === undefined ? null : attachmentBytes(media.data);

      if (bytes === null) return null;
      const { storage, planes } = deps.files();
      const path = await storeAttachment(storage.vfs, `${storage.home}/${SPILL_DIRS.attachments}`, bytes, attachment.mimeType);

      return formatPath(path, planes);
    },
  };
}

function attachmentOf(media: CarriedMedia): Attachment | null {
  const image = mediaImage(media);
  const mimeType = image?.mediaType ?? media.mediaType;

  return mimeType === undefined ? null : {
    id: media.id, kind: media.kind, mimeType, ...(image !== null && { width: image.width, height: image.height }),
  };
}
