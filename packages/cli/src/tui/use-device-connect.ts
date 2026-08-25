/**
 * Device-connect prompt state machine shared by the TUI surfaces (home-app on
 * cloud-agent creation, chat-app on cloud chat open and /connect). Owns the
 * ask → connecting → result flow over the device-connect module; the rendering
 * lives in DeviceConnectOverlay and key routing in the host's useKeyboard.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { requireAuthConfig } from '../config';
import {
  connectDevice,
  defaultDeviceName,
  describeConnectOutcome,
  deviceStatusLine,
  dismissDeviceConnectPrompt,
  shouldOfferDeviceConnect,
} from '../device-connect';
import { renderThrownChain } from '@kinu.run/core/obs';
import { createKeyDispatcher, useKeybindingRegistry, type TuiKeyEvent } from './actions';

export type DeviceConnectPromptState =
  | { phase: 'ask'; statusLine: string; deviceName: string }
  | { phase: 'connecting'; session: boolean; ticks: number }
  | { phase: 'result'; ok: boolean; message: string };

const RESULT_LINGER_MS = 2_500;

export interface DeviceConnectPrompt {
  state: DeviceConnectPromptState | null;
  /** Offer the prompt when no device is connected (at most once per CLI
   *  invocation); resolves when the prompt closes — or immediately when
   *  there is nothing to ask. */
  offerIfUnconnected(): Promise<void>;
  /** Open unconditionally with current device status (the /connect command). */
  open(): Promise<void>;
  /** Route a key press; true when the prompt consumed it. */
  handleKey(key: TuiKeyEvent): boolean;
}

export function useDeviceConnectPrompt(): DeviceConnectPrompt {
  const keybindings = useKeybindingRegistry();
  const dispatcher = useMemo(() => createKeyDispatcher(keybindings), [keybindings]);
  const [state, setState] = useState<DeviceConnectPromptState | null>(null);
  const stateRef = useRef<DeviceConnectPromptState | null>(null);
  const doneRef = useRef<(() => void) | null>(null);
  const lingerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const update = useCallback((next: DeviceConnectPromptState | null) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const close = useCallback(() => {
    if (lingerRef.current) clearTimeout(lingerRef.current);
    lingerRef.current = null;
    const done = doneRef.current;
    doneRef.current = null;
    update(null);
    done?.();
  }, [update]);

  const beginAsk = useCallback((statusLine: string) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    doneRef.current = resolve;
    update({ phase: 'ask', statusLine, deviceName: defaultDeviceName() });
    return promise;
  }, [update]);

  const offerIfUnconnected = useCallback(async () => {
    if (stateRef.current) return;
    if (!(await shouldOfferDeviceConnect())) return;
    await beginAsk('No PC is connected to your account yet.');
  }, [beginAsk]);

  const open = useCallback(async () => {
    if (stateRef.current) return;
    await beginAsk(await deviceStatusLine());
  }, [beginAsk]);

  const startConnect = useCallback((session: boolean) => {
    update({ phase: 'connecting', session, ticks: 0 });
    void (async () => {
      try {
        const auth = requireAuthConfig();
        const result = await connectDevice(auth, {
          session,
          label: defaultDeviceName(),
          onPoll: () => {
            const current = stateRef.current;
            if (current?.phase === 'connecting') update({ ...current, ticks: current.ticks + 1 });
          },
        });
        const outcome = describeConnectOutcome(result, session);
        update({ phase: 'result', ok: outcome.ok, message: outcome.message });
      } catch (err) {
        update({ phase: 'result', ok: false, message: renderThrownChain({ cause: err }) });
      }
      lingerRef.current = setTimeout(close, RESULT_LINGER_MS);
    })();
  }, [close, update]);

  const handleKey = useCallback((key: TuiKeyEvent): boolean => {
    const current = stateRef.current;
    if (!current) return false;
    if (current.phase === 'ask') {
      const result = dispatcher.feed(key, ['device']);
      if (result.actionId === 'device.connect') startConnect(false);
      else if (result.actionId === 'device.ssh') startConnect(true);
      else if (result.actionId === 'device.dismiss') {
        dismissDeviceConnectPrompt();
        close();
      } else if (result.actionId === 'device.not-now') close();
      return true;
    }
    if (current.phase === 'result') {
      close();
      return true;
    }
    return true;
  }, [close, dispatcher, startConnect]);

  return { state, offerIfUnconnected, open, handleKey };
}
