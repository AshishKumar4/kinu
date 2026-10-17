// 2026-10-17: a container started from a snapshot left reads of its root never completed, every process reading a block
// it did not yet hold slept in D for good, and a stop's kill of it never landed. A FUSE daemon that stopped answering
// sleeps its callers interruptibly, with no read of the root in flight. The readings below are the probe's own lines
// from those boxes (`kinu-logs/container-btrfs-wedge-2026-10-17`).
import { describe, expect, test } from 'bun:test';
import { diskStallOf } from '../src/disk-stall';

const stalled = [
  'process 1 S 0 - tini',
  'process 37 D 36 read_extent_buffer_pages bash',
  'process 61 D 37 folio_wait_bit_common openbox',
  'process 70 S 1 - sandbox-shim',
  'root /dev/vdc 27       16',
].join('\n');

describe('a stop waiting on a disk that stopped answering', () => {
  test('is a process of the stopped tree in D while the root has reads in flight', () => {
    expect(diskStallOf(stalled, [36])).toEqual({ waiting: ['bash (read_extent_buffer_pages)', 'openbox (folio_wait_bit_common)'], device: '/dev/vdc', reads: 27 });
  });

  test('is not a FUSE daemon that stopped answering: its callers sleep interruptibly and the root reads nothing', () => {
    const fuse = ['process 1 S 0 - tini', 'process 42 T 1 - s3fs', 'process 703 S 1 - bash', 'process 704 S 703 - bash', 'root /dev/vdc 0        0'].join('\n');

    expect(diskStallOf(fuse, [703])).toBe(null);
  });

  test('is not a busy disk under a tree that waits on nothing, nor another tree in D', () => {
    expect(diskStallOf(stalled, [70])).toBe(null);
    expect(diskStallOf(['process 37 D 36 read_extent_buffer_pages bash', 'root /dev/vdc 0        3'].join('\n'), [36])).toBe(null);
  });

  // 2026-10-17, run 26: s3fs under the container's exec agent, whose parent is outside the container (0), not init.
  test('is read for the whole box where no tree is named, the container\'s own runs included', () => {
    const platform = ['process 1 S 0 - tini', 'process 40 S 0 - sandbox-shim', 'process 41 D 40 folio_wait_bit_common s3fs', 'root /dev/vdc 62       16'].join('\n');

    expect(diskStallOf(platform)).toEqual({ waiting: ['s3fs (folio_wait_bit_common)'], device: '/dev/vdc', reads: 62 });
    expect(diskStallOf(platform, [1])).toBe(null);
  });

  test('is never read on a root that is no block device', () => {
    expect(diskStallOf(stalled.replace(/^root .*$/mu, ''), [36])).toBe(null);
  });
});
