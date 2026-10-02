export interface JobName {
  readonly title: string;
  readonly shortId: string;
}

export function shortJobId(id: string): string {
  return id.replace(/^bgjob-/, '').slice(0, 8);
}

export function jobName(job: { readonly id: string; readonly kind: string; readonly label?: string | null }): JobName {
  const label = job.label ?? '';

  return { title: label === '' ? job.kind : label, shortId: shortJobId(job.id) };
}
