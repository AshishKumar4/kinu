/**
 * Images within one turn (D89). The turn's ladder moves older images out only as the turn starts; a turn that looks at
 * the screen step after step would otherwise carry every screenshot until the step budget overflows. So each step
 * moves the images its turn's calls returned, past the latest {@link KEEP_RECENT_IMAGES}, to the agent's home through
 * the same store the ladder uses, each left as a link the agent can open again. The turn is read off the history
 * itself, everything since its last ask, not off the execution that made the calls: a turn restored after its host was
 * lost carries every screenshot its earlier executions took (a staging trial's grew to 330,000 tokens). Earlier turns'
 * images, and what the owner attached, stay the ladder's to move.
 *
 * The cutoff moves in batches of {@link STEP_IMAGE_BATCH}: between moves each request extends the last, so the
 * provider's cache holds. Measured on two models over a 24-step turn of screenshots, batches of four cost 35% (Claude)
 * and 29% (GPT) less than moving one image a step, and kept the context a quarter smaller than batches of eight.
 */
import type { ModelMessage } from 'ai';
import type { Attachment, AttachmentLocation, Turn } from '@better-compact/core';
import { carriedMedia, kinuCodec } from './codec';
import { KEEP_RECENT_IMAGES, type AttachmentStore } from './attachments';

/** Images moved out at once, past the latest {@link KEEP_RECENT_IMAGES}. */
const STEP_IMAGE_BATCH = 4;

/** The text left in an image's place: the rung's form, its arrow in ASCII, as model text is written. */
function stub(attachment: Attachment, link: string): string {
  const dimensions = attachment.width !== undefined && attachment.height !== undefined ? ` ${String(attachment.width)}x${String(attachment.height)}` : '';

  return `[${attachment.mimeType}${dimensions} -> ${link}]`;
}

interface Placed {
  readonly turn: number;
  readonly item: number;
  readonly location: AttachmentLocation;
  readonly attachment: Attachment;
  /** The payload, which the link is kept by: a step's history repeats it. */
  readonly payload: unknown;
}

/** Each image a call returned since the last ask in `turns`, oldest first. */
function imagesOf(turns: readonly Turn[], store: AttachmentStore): Placed[] {
  let ask = turns.length;

  while (ask > 0 && turns[ask - 1]?.role !== 'user') ask -= 1;

  return turns.flatMap((turn, at) => turn.items.flatMap((item, index) => store.list(item).flatMap((attachment): Placed[] => {
    if (attachment.kind !== 'image' || item.kind !== 'tool' || at < ask) return [];
    const media = carriedMedia(item).find((carried) => carried.id === attachment.id);
    // A step knows no session; the store keeps an image by its bytes alone.
    const location = { sessionKey: '', turnKey: turn.key, itemKey: item.key };

    return media === undefined ? [] : [{ turn: at, item: index, location, attachment, payload: media.data }];
  })));
}

/** What a turn's steps share: what they stored, by payload. Its owner renews it per turn. */
export interface TurnImages {
  readonly links: Map<unknown, string | null>;
}

/** Files the calls since the last ask in `messages` returned, by a look at the parts alone: most steps have too few to
 *  move any. */
function carriedFiles(messages: readonly ModelMessage[]): number {
  let files = 0;
  let ask = messages.length;

  while (ask > 0 && messages[ask - 1]?.role !== 'user') ask -= 1;

  for (const message of messages.slice(ask)) {
    if (message.role !== 'tool') continue;

    for (const part of message.content) {
      if (part.type === 'tool-result' && part.output.type === 'content') {
        files += part.output.value.filter((entry) => entry.type === 'file').length;
      }
    }
  }

  return files;
}

/** A step's pass over `messages`: undefined when no image moves; synchronous when every moving image is stored already. */
export function moveStepImages(
  messages: readonly ModelMessage[], store: AttachmentStore, turn: TurnImages,
): ModelMessage[] | undefined | Promise<ModelMessage[] | undefined> {
  // Read whole only when a batch could move: a long turn's history is large, and its steps are many.
  if (carriedFiles(messages) < KEEP_RECENT_IMAGES + STEP_IMAGE_BATCH) return undefined;
  const { links } = turn;
  const turns = kinuCodec.encode([...messages]);
  const images = imagesOf(turns, store);
  const moving = images.slice(0, Math.floor(Math.max(0, images.length - KEEP_RECENT_IMAGES) / STEP_IMAGE_BATCH) * STEP_IMAGE_BATCH);

  if (moving.length === 0) return undefined;

  const placed = (): ModelMessage[] | undefined => {
    let moved = false;

    for (const image of moving) {
      const link = links.get(image.payload);
      const held = turns[image.turn];
      const item = held?.items[image.item];

      if (link === null || link === undefined || held === undefined || item === undefined) continue;
      held.items[image.item] = store.replace(item, image.attachment, stub(image.attachment, link));
      moved = true;
    }

    return moved ? kinuCodec.decode(turns, [...messages]) : undefined;
  };

  const unstored = moving.filter((image) => !links.has(image.payload));

  if (unstored.length === 0) return placed();

  return (async () => {
    for (const image of unstored) {
      const item = turns[image.turn]?.items[image.item];

      // A payload that cannot be read stays in place, and is not tried again this turn.
      links.set(image.payload, item === undefined ? null : await store.store(image.attachment, item, image.location));
    }

    return placed();
  })();
}
