/** `/pc/*`: the device tunnel's own auth (core `http/pc-ingress.ts`). */
import { Hono } from 'hono';
import { DEVICE_CONNECT_PATH, handlePcConnect, handlePcConnectTicket, type PcIngressEnv } from '@kinu.run/core';
import { beneath, type FamilyEnv } from './api/context';

export const pcRoutes = new Hono<FamilyEnv<PcIngressEnv<unknown>, object>>();

pcRoutes.post('/pc/connect-ticket', async (c) => handlePcConnectTicket(c.req.raw, c.env));

pcRoutes.all('/pc/connect-ticket', async () => new Response('Method not allowed', { status: 405 }));

pcRoutes.all(DEVICE_CONNECT_PATH, async (c) => handlePcConnect(c.req.raw, c.env));

pcRoutes.all('/pc/*', beneath<FamilyEnv<PcIngressEnv<unknown>, object>>('/pc', async () => new Response('Not found', { status: 404 })));
