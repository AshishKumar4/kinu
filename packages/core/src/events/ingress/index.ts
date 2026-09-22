/** Adapters build an `IngressDescriptor` and publish; trust, priority and visibility are derived by
 *  the hub, never asserted at the ingress site. */
export * from './container';

export * from './webhook';

export * from './secrets';

export * from './rate-limit';

export * from './triggers';

export * from './email';

export * from './peer';

export * from './subordinate';
