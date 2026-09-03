/**
 * Lazy page-in and clean eviction: what a box holds of the head it serves.
 *
 * WHY A WAKE MUST NOT READ THE TREE. An attach that materializes every file
 * pays one remote operation per file — 200,006 of them for 1e5 files on
 * bounded-layers, 5 against 4 on merkle-pack, both measured by the conformance
 * bar's cell 6.13 on 2026-09-02. Neither number is a function of what the
 * generation changed, and a wake that scales with what the TREE holds cannot
 * be made fast by making the transport faster. So the attach reads the root
 * record and the ledger, the tree arrives on first touch, and this is the
 * thing that touches it.
 *
 * THE PAGE IS THE HYDRATE QUANTUM, and its size is measured rather than
 * chosen: R2 answers a 64 KiB range and a 1 MiB range in the same ~50-60 ms
 * (latency-bound), and 8 MiB amortises bandwidth better but multiplies the
 * bytes a page-in moves by eight (`bench/measure-first/MEASUREMENTS.md`,
 * 2026-09-02). One MiB is the cliff, so it is the page.
 *
 * A HOLE IS NEVER FETCHED. A placeholder is created at its full length, so its
 * holes already read as zeros; a page with no data span under it is resident
 * the moment it is asked for, at no remote cost. That is what keeps a 1 GiB
 * sparse file's wake O(its data) instead of O(its size).
 *
 * EVICTION RISKS NOTHING BUT A RE-READ. Every page here is CLEAN by
 * construction: bytes that came out of an immutable object, held to the digest
 * the head declares for them. A path the workload writes leaves through
 * {@link Residency.forget} — its bytes are the container's, not the head's,
 * and this sweep can never reach them. So dropping a clean page cannot lose a
 * write, and the range read that brings it back is idempotent and verified.
 */

import { CLEAN_PAGE_IDLE_MS, HYDRATE_PAGE_BYTES, type GcWork, type HydrateWork } from '../durability/contracts';

/** One contiguous logical range of a file. */
export interface DataSpan {
  readonly offset: number;
  readonly length: number;
}

/**
 * What the head says one file is: how long, and where its bytes actually are.
 * Everything the spans do not cover is a hole, and a hole is free.
 */
export interface FileGeometry {
  readonly size: number;
  /** Data spans in file order, non-overlapping. */
  readonly data: readonly DataSpan[];
}

/**
 * The seams a residency needs: the verified read that fills a window, the
 * place the bytes land, and the drop that releases them again.
 *
 * `place` and `drop` are the CONTAINER's, never this module's: the bytes
 * belong to the file the workload reads, so a page cache that held its own
 * copy would double every resident byte on a disk capped at 2-20 GiB.
 */
export interface ResidencyPorts {
  /** Logical bytes `[offset, offset + length)` of one file, digest-verified by
   *  the view that serves them. Exactly `length` bytes, or it throws. */
  read(path: string, offset: number, length: number): Promise<Uint8Array>;
  /** Put paged-in bytes where the reader will find them. */
  place(path: string, offset: number, bytes: Uint8Array): void;
  /** Release a page's bytes. The file keeps its length; the range reads as
   *  zeros again until it is paged back in. */
  drop(path: string, offset: number, length: number): void;
  /** Monotonic milliseconds. The idle window is measured against it. */
  now(): number;
  /** Bytes one page holds. Defaults to {@link HYDRATE_PAGE_BYTES}. */
  readonly pageBytes?: number;
  /** How long a clean page may sit untouched. Defaults to
   *  {@link CLEAN_PAGE_IDLE_MS}. */
  readonly idleMs?: number;
}

/** How much of the head is local, in the sidecar status's own words. */
export interface Hydration {
  readonly residentBytes: number;
  readonly treeBytes: number;
  /** Files with at least one data page still to page in. */
  readonly placeholders: number;
}

/** What one eviction sweep may drop. */
export interface EvictionRequest {
  /**
   * Override the idle window for this sweep. Disk pressure passes 0: every
   * clean page goes, because the alternative is refusing the write.
   */
  readonly idleMs?: number;
}

/** One page of one file: whether its bytes are here, and when last read. */
interface Page {
  /** Data bytes under this page. A page with none is resident for free. */
  readonly dataBytes: number;
  resident: boolean;
  touchedAt: number;
}

interface Resident {
  readonly geometry: FileGeometry;
  /** Only pages that have been asked for. A 1 GiB file that nobody read holds
   *  no page rows at all, which is what keeps a placeholder O(1). */
  readonly pages: Map<number, Page>;
  /** Data bytes the head declares for this file: the residency's denominator. */
  readonly dataBytes: number;
  residentBytes: number;
}

/** Data bytes of a geometry, holes excluded: a placeholder's denominator and
 *  the only figure a hydration ratio may be measured against. */
function dataBytesOf(geometry: FileGeometry): number {
  let total = 0;
  for (const span of geometry.data) total += span.length;
  return total;
}

/**
 * The residency of one published head over one container.
 *
 * Registered files are placeholders until read. A read pages in exactly the
 * windows it crosses, coalescing adjacent misses into one range read; a sweep
 * drops what nothing has touched inside the window. Both report the counted
 * rows the durability contract declares — {@link HydrateWork} for the page-in,
 * {@link GcWork} for the sweep — so a bound can be checked against what ran.
 */
export class Residency {
  readonly #ports: ResidencyPorts;
  readonly #pageBytes: number;
  readonly #idleMs: number;
  readonly #files = new Map<string, Resident>();
  #rangeGets = 0;
  #bytesFetched = 0;
  #bytesRequested = 0;
  #gc: GcWork = { deletes: 0, markPages: 0, markBytes: 0 };

  constructor(ports: ResidencyPorts) {
    this.#ports = ports;
    this.#pageBytes = ports.pageBytes ?? HYDRATE_PAGE_BYTES;
    this.#idleMs = ports.idleMs ?? CLEAN_PAGE_IDLE_MS;
    if (this.#pageBytes <= 0) throw new Error(`a page must hold bytes, got ${this.#pageBytes}`);
  }

  /** Declare one file of the head as a placeholder: its length and geometry
   *  are known, none of its bytes are here. Re-registering resets residency,
   *  which is what a new generation of the same path is. */
  register(path: string, geometry: FileGeometry): void {
    for (const span of geometry.data) {
      if (span.offset < 0 || span.length < 0 || span.offset + span.length > geometry.size) {
        throw new Error(`${path}: data span ${span.offset}+${span.length} lies outside a ${geometry.size}-byte file`);
      }
    }
    this.#files.set(path, {
      geometry,
      pages: new Map(),
      dataBytes: dataBytesOf(geometry),
      residentBytes: 0,
    });
  }

  /** Declare one file already whole and clean: what a publish leaves behind,
   *  when every byte in the tree has become a cache of the new head. */
  registerResident(path: string, geometry: FileGeometry): void {
    this.register(path, geometry);
    const held = this.#files.get(path)!;
    const now = this.#ports.now();
    for (let page = 0; page * this.#pageBytes < Math.max(geometry.size, 1); page += 1) {
      const dataBytes = this.#dataBytesOfPage(held, page);
      held.pages.set(page, { dataBytes, resident: true, touchedAt: now });
      held.residentBytes += dataBytes;
    }
  }

  /** The path is the container's now, not the head's: a write happened, so its
   *  bytes are unpublished and no sweep may touch them. */
  forget(path: string): void {
    this.#files.delete(path);
  }

  /** Every path still served from the head. */
  paths(): readonly string[] {
    return [...this.#files.keys()];
  }

  /** Does this path still page in, or has the container taken it over? */
  holds(path: string): boolean {
    return this.#files.has(path);
  }

  geometryOf(path: string): FileGeometry | undefined {
    return this.#files.get(path)?.geometry;
  }

  /**
   * Make `[offset, offset + length)` readable, paying only for what is missing.
   *
   * Adjacent missing pages become ONE range read, and the read covers only the
   * data spans under them: a window over a hole costs nothing, and a window
   * over a 16-byte file fetches 16 bytes rather than a page.
   */
  async hydrate(path: string, offset: number, length: number): Promise<void> {
    const held = this.#files.get(path);
    if (held === undefined) return;
    const size = held.geometry.size;
    const start = Math.min(Math.max(offset, 0), size);
    const end = Math.min(start + Math.max(length, 0), size);
    if (end <= start) return;
    this.#bytesRequested += end - start;
    const now = this.#ports.now();
    const first = Math.floor(start / this.#pageBytes);
    const last = Math.floor((end - 1) / this.#pageBytes);
    // One pass, one coalesced run of misses at a time: a missing run is fetched
    // when the next resident page (or the end) closes it.
    let runFrom: number | null = null;
    for (let page = first; page <= last; page += 1) {
      const row = this.#pageAt(held, page, now);
      if (row.resident) {
        row.touchedAt = now;
        if (runFrom !== null) {
          await this.#fill(path, held, runFrom, page - 1, now);
          runFrom = null;
        }
        continue;
      }
      runFrom ??= page;
    }
    if (runFrom !== null) await this.#fill(path, held, runFrom, last, now);
  }

  /** Page in every data byte of one file: what a reader of the whole file
   *  asks for, and what a container owes before it writes into one. */
  async hydrateWhole(path: string): Promise<void> {
    const held = this.#files.get(path);
    if (held === undefined) return;
    await this.hydrate(path, 0, held.geometry.size);
  }

  /**
   * Drop every clean page nothing has touched inside the window.
   *
   * The row is {@link GcWork}: `deletes` counts pages dropped, and the mark
   * counts what the sweep examined — page rows only, never a payload byte.
   */
  evict(request: EvictionRequest = {}): GcWork {
    const idleMs = request.idleMs ?? this.#idleMs;
    const now = this.#ports.now();
    let deletes = 0;
    let markPages = 0;
    let markBytes = 0;
    for (const [path, held] of this.#files) {
      for (const [index, page] of held.pages) {
        markPages += 1;
        if (!page.resident) continue;
        markBytes += page.dataBytes;
        if (now - page.touchedAt < idleMs) continue;
        page.resident = false;
        held.residentBytes -= page.dataBytes;
        deletes += 1;
        if (page.dataBytes === 0) continue;
        const from = index * this.#pageBytes;
        this.#ports.drop(path, from, Math.min(this.#pageBytes, held.geometry.size - from));
      }
    }
    this.#gc = {
      deletes: this.#gc.deletes + deletes,
      markPages: this.#gc.markPages + markPages,
      markBytes: this.#gc.markBytes + markBytes,
    };
    return { deletes, markPages, markBytes };
  }

  /** Resident data bytes, right now. What an eviction can free. */
  get residentBytes(): number {
    let total = 0;
    for (const held of this.#files.values()) total += held.residentBytes;
    return total;
  }

  /** How much of the head is local, and how many files still hold a gap. */
  hydration(): Hydration {
    let residentBytes = 0;
    let treeBytes = 0;
    let placeholders = 0;
    for (const held of this.#files.values()) {
      residentBytes += held.residentBytes;
      treeBytes += held.dataBytes;
      if (held.residentBytes < held.dataBytes) placeholders += 1;
    }
    return { residentBytes, treeBytes, placeholders };
  }

  /** What page-in has cost since this residency opened. */
  work(): HydrateWork {
    return { rangeGets: this.#rangeGets, bytesFetched: this.#bytesFetched, bytesRequested: this.#bytesRequested };
  }

  /** What eviction has done since this residency opened. */
  gcWork(): GcWork {
    return this.#gc;
  }

  /** Fetch the data under pages `[from, to]` and place it. One range read per
   *  contiguous data span under the run: a run over holes issues none. */
  async #fill(path: string, held: Resident, from: number, to: number, now: number): Promise<void> {
    const windowStart = from * this.#pageBytes;
    const windowEnd = Math.min((to + 1) * this.#pageBytes, held.geometry.size);
    for (const span of held.geometry.data) {
      const start = Math.max(windowStart, span.offset);
      const end = Math.min(windowEnd, span.offset + span.length);
      if (start >= end) continue;
      this.#rangeGets += 1;
      this.#bytesFetched += end - start;
      const bytes = await this.#ports.read(path, start, end - start);
      if (bytes.byteLength !== end - start) {
        throw new Error(`${path}: page-in of ${start}+${end - start} answered ${bytes.byteLength} bytes`);
      }
      this.#ports.place(path, start, bytes);
    }
    for (let page = from; page <= to; page += 1) {
      const row = this.#pageAt(held, page, now);
      if (row.resident) continue;
      row.resident = true;
      row.touchedAt = now;
      held.residentBytes += row.dataBytes;
    }
  }

  /** The page row, created on first mention. A hole-only page is born
   *  resident: its zeros are already what a read of it must answer. */
  #pageAt(held: Resident, page: number, now: number): Page {
    const existing = held.pages.get(page);
    if (existing !== undefined) return existing;
    const dataBytes = this.#dataBytesOfPage(held, page);
    const row: Page = { dataBytes, resident: dataBytes === 0, touchedAt: now };
    held.pages.set(page, row);
    return row;
  }

  #dataBytesOfPage(held: Resident, page: number): number {
    const from = page * this.#pageBytes;
    const to = Math.min(from + this.#pageBytes, held.geometry.size);
    let bytes = 0;
    for (const span of held.geometry.data) {
      const start = Math.max(from, span.offset);
      const end = Math.min(to, span.offset + span.length);
      if (start < end) bytes += end - start;
    }
    return bytes;
  }
}

/** The geometry of a file with no holes: one span over everything. */
export function denseGeometry(size: number): FileGeometry {
  return { size, data: size === 0 ? [] : [{ offset: 0, length: size }] };
}
