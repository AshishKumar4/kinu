import { defineTaskEval } from '../src/eval';
import { defineEvalTask } from '../src/task';
import { fileHousekeeping } from './file-housekeeping';
import { freightDesk } from './freight-desk';
import { latencyChart } from './latency-chart';
import { ledgerReconcile } from './ledger-reconcile';
import { memoryRecall } from './memory-recall';
import { offsiteVenue } from './offsite-venue';
import { pricingTreatments } from './pricing-treatments';

// The everyday asks of a small business, one workspace for all of them. The one-off views come first: each checks
// that the workspace holds no file slate, and the venue part ends by building one. Memory ends with a fresh chat.
defineTaskEval(defineEvalTask({
  id: 'office',
  mission: "Juniper Row's back office. We run two bakery shops and the Tern Street deli, take deliveries through the "
    + 'Harbor Freight co-op, sell Lumen Notes, an app whose payments API we keep on call, and plan the team offsites. '
    + 'Files, books, prices and the codes we keep land here.',
  parts: [latencyChart, pricingTreatments, offsiteVenue, fileHousekeeping, ledgerReconcile, freightDesk, memoryRecall],
}));
