/**
 * Every Cloudflare platform number, by its id in `platform-catalog.ts`, which records how each was established. Kept
 * apart from that evidence so the code that obeys a number loads only the number: the browser loaded the catalog's
 * prose for a few numbers, 113 KB raw of its app chunk (2026-10-28). Null for a behaviour with no number.
 */
import type { PLATFORM_CATALOG } from './platform-catalog';

export type LimitUnit = 'bytes' | 'ms' | 'count';

/** Base unit only; call sites must not convert. */
export interface PlatformQuantity {
  readonly value: number;
  readonly unit: LimitUnit;
}

const KiB = 1024;

export const MiB = 1024 * 1024;

/** Cloudflare's documented sizes are decimal (DO limits page, footnote 2); where readings differ the smaller is used. */
export const MB = 1000 * 1000;

export const GB = 1000 * 1000 * 1000;

export const PLATFORM_LIMITS = {
  'container.instance.vcpu': { value: 2, unit: 'count' },
  'container.instance.memory': { value: 6_144 * MiB, unit: 'bytes' },
  'container.instance.disk': { value: 8_000 * MB, unit: 'bytes' },
  'worker.isolate.memory': { value: 128 * MB, unit: 'bytes' },
  'do.isolate.oom_catchable': { value: 256 * MiB, unit: 'bytes' },
  'do.isolate.reset_silent': { value: 200 * MiB, unit: 'bytes' },
  'do.isolate.generation_counter': null,
  'do.isolate.oom_reported': null,
  'do.isolate.cotenancy': null,
  'worker.memory_usage_unobservable': null,
  'do.block_concurrency.cancel_ms': { value: 30_000, unit: 'ms' },
  'do.init_gate.awaited_by': null,
  'do.input_gate.scope': null,
  'do.cpu_ms_per_invocation': { value: 30_000, unit: 'ms' },
  'do.alarm.wall_ms': { value: 900_000, unit: 'ms' },
  'worker.wall.http_unlimited': null,
  'worker.wait_until.grace_ms': { value: 30_000, unit: 'ms' },
  'do.wait_until.no_op': null,
  'do.background_task.cancelled_on_reset': null,
  'date_now.frozen_between_io': null,
  'rpc.arg_bytes': { value: 32 * MiB, unit: 'bytes' },
  'facet.rpc_payload_budget': { value: 28 * MiB, unit: 'bytes' },
  'run_events.page_bytes': { value: 256 * KiB, unit: 'bytes' },
  'files.page_bytes': { value: 256 * KiB, unit: 'bytes' },
  'rpc.clone_refused': null,
  'rpc.prototype_chain': null,
  'do.storage.wasm_module_unreadable': null,
  'isolate.codegen_blocked': null,
  'worker_loader.do_dynamic_worker_concurrency': { value: 10, unit: 'count' },
  'worker_loader.child_cached_by_name': null,
  'atomics.wait_unavailable': null,
  'do.sqlite.row_bytes': { value: 8 * MiB, unit: 'bytes' },
  'do.sqlite.statement_bytes': { value: 100 * KiB, unit: 'bytes' },
  'do.sqlite.bound_params': { value: 100, unit: 'count' },
  'do.sqlite.like_pattern_bytes': { value: 50, unit: 'bytes' },
  'do.sqlite.columns_per_table': { value: 100, unit: 'count' },
  'do.storage.bytes': { value: 10 * GB, unit: 'bytes' },
  'sqlite.nomem': null,
  'do.kv.value_bytes': { value: 128 * KiB, unit: 'bytes' },
  'do.isolate.transient_alloc_reset': { value: 128 * MiB, unit: 'bytes' },
  'worker.memory_kill_is_burst_sensitive': null,
  'do.storage.size_is_per_object': null,
  'do.storage.sync_kv': { value: 8_388_620, unit: 'bytes' },
  'do.requests_per_second_soft': { value: 1_000, unit: 'count' },
  'worker.subrequests': { value: 10_000, unit: 'count' },
  'worker.connect.private_address': null,
  'r2.etag.compressed_weak': null,
  'worker.connect.address_forms': null,
  'worker.fetch.private_address': null,
  'worker.fetch.chatgpt_refused': null,
  'kv.read.cross_location_stale': { value: 60_000, unit: 'ms' },
  'worker.simultaneous_connections': { value: 6, unit: 'count' },
  'do.evict.no_signal': null,
  'do.reset.transient': null,
  'do.storage.write_await_reset': { value: 1_000, unit: 'ms' },
  'websocket.message_bytes': { value: 32 * MiB, unit: 'bytes' },
  'email.routing.rules_per_domain': { value: 200, unit: 'count' },
  'email.routing.message_bytes': { value: 25 * MiB, unit: 'bytes' },
  'websocket.hibernation_state': null,
  'do.facet.memory_independent': { value: 125 * MB, unit: 'bytes' },
  'do.facet.cpu_turns_reset_parent': { value: 100, unit: 'ms' },
  'do.facet.cpu_shared': null,
  'do.facet.cpu_ms': { value: 30_000, unit: 'ms' },
  'do.facet.subrequests': { value: 10_000, unit: 'count' },
  'do.facet.abort_reuses_isolate': null,
  'do.facet.rpc_bytes': { value: 32 * MiB, unit: 'bytes' },
  'do.facet.no_alarms': null,
  'do.facet.stub_local': null,
  'do.facet.eviction_joint': null,
  'do.facet.count': { value: 65_536, unit: 'count' },
  'do.facet.creation_degrades': { value: 31_300, unit: 'count' },
  'do.facet.clone_name_unvalidated': null,
  'do.facet.clone_cow': null,
  'worker_loader.limits_no_memory': null,
  'tracing.scoped_spans_only': null,
  'tracing.inert_locally': null,
  'worker.v8_pointer_compression': null,
  'do.facet.id_is_root_namespace': null,
  'do.facet.work_is_traced': null,
  'worker.script_bytes': { value: 64 * MiB, unit: 'bytes' },
  'worker.startup_ms': { value: 1_000, unit: 'ms' },
  'facet.module_text_bytes': { value: 8 * MiB, unit: 'bytes' },
  'workers_dev.fresh_route_404': null,
  'edge.websocket_idle_reap_ms': { value: 100_000, unit: 'ms' },
  'websocket.protocol_ping_auto_answered': null,
  'facet.rpc_timeout_ms': { value: 30_000, unit: 'ms' },
  'provider.stream.idle_ms': { value: 360_000, unit: 'ms' },
  'job.context_silence_ms': { value: 600_000, unit: 'ms' },
  'browser.session.keep_alive_ms': { value: 1_200_000, unit: 'ms' },
  'do.placement.location_hint': null,
  'provider.region.served': null,
} as const satisfies Readonly<Record<string, PlatformQuantity | null>>;

export type PlatformFactId = keyof typeof PLATFORM_LIMITS;

/** Since the last byte, never a total. */
export type SilenceBoundId = {
  [Id in PlatformFactId]: (typeof PLATFORM_CATALOG)[Id]['bounds'] extends 'silence' ? Id : never;
}[PlatformFactId];

export function silenceBoundMs(id: SilenceBoundId): number {
  return PLATFORM_LIMITS[id].value;
}
