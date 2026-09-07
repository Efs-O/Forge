/**
 * Power-state tools: put this machine to sleep, arm the RTC to bring it back,
 * and report what waking it from outside would take.
 *
 * All three delegate to `PowerControl` — nothing here spawns a process itself.
 */

import type { RegisteredTool } from './ToolRegistry';
import { PowerControl, WakeTimersDisabledError, type SuspendResult } from '../system/PowerControl';
import { formatWakeInfo, parseWakeTime } from '../system/wakeInfo';

/**
 * Grace period before the machine actually suspends.
 *
 * The tool result has to reach the model, the model has to write its closing
 * reply, and that reply has to reach the sidebar and any paired chat. Suspending
 * the instant the handler returns cuts all three off, and the user wakes the
 * machine later to a turn that ends mid-sentence.
 */
const DEFAULT_SLEEP_DELAY_SECONDS = 20;
const MAX_SLEEP_DELAY_SECONDS = 600;

function describeSuspend(result: SuspendResult, delaySeconds: number): string {
  const state =
    result.requested === 'hibernate'
      ? 'hibernate'
      : result.hibernationEnabled
        ? 'sleep (hibernation is enabled on this machine, so it may hibernate instead)'
        : 'sleep';
  return (
    `This machine will ${state} in ${delaySeconds} seconds. ` +
    'Say what you have to say now — once it suspends, nothing on this machine is ' +
    'running, so you cannot report anything further and cannot wake it back up. ' +
    'It returns only from a Wake-on-LAN magic packet or an armed wake timer.'
  );
}

export function makeSleepComputerTool(power: PowerControl): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'sleep_computer',
        description:
          'Put THIS machine to sleep. Ends the turn and every running process a ' +
          'few seconds later — VS Code, Forge, and any paired chat all go offline ' +
          'until the machine is woken from outside. Only call it when the user has ' +
          'asked for it in this conversation; never as cleanup, never to save power, ' +
          'and never on your own initiative. To bring the machine back at a known ' +
          'time, call schedule_wake FIRST, then this.',
        parameters: {
          type: 'object',
          properties: {
            hibernate: {
              type: 'boolean',
              description:
                'Hibernate (S4) instead of sleeping (S3). Survives a power cut, but ' +
                'resumes more slowly and Wake-on-LAN is less reliable from it. ' +
                'Defaults to false.',
            },
            delay_seconds: {
              type: 'number',
              minimum: 0,
              maximum: MAX_SLEEP_DELAY_SECONDS,
              description:
                `Seconds to wait before suspending. Defaults to ${DEFAULT_SLEEP_DELAY_SECONDS}, ` +
                'which is the room your closing reply needs to reach the user before the ' +
                'machine goes down. Raise it if something still has to finish.',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    permission: 'terminal',
    // Always gated, never auto-approved: `dangerous` is what keeps clanker mode
    // from suspending the machine without anyone being asked.
    approval: (args) => ({
      dangerous: true,
      detail:
        `${args['hibernate'] === true ? 'Hibernate' : 'Sleep'} this machine in ` +
        `${args['delay_seconds'] ?? DEFAULT_SLEEP_DELAY_SECONDS}s. Everything stops until it is ` +
        'woken by a magic packet or a wake timer.',
    }),
    handler: async (args) => {
      const requested = args['delay_seconds'];
      const delaySeconds =
        typeof requested === 'number' && Number.isFinite(requested)
          ? Math.min(Math.max(0, Math.round(requested)), MAX_SLEEP_DELAY_SECONDS)
          : DEFAULT_SLEEP_DELAY_SECONDS;
      const hibernate = args['hibernate'] === true;

      // Preflighted before the timer is set, so a machine that cannot suspend
      // says so in the tool result instead of failing silently in the dark.
      const info = await power.describeWake();
      if (info.availableStates.length === 0) {
        throw new Error(
          'sleep_computer: this machine reports no available sleep states, so it cannot be ' +
            'suspended. Run `powercfg /a` to see why.',
        );
      }

      const suspend = (): void => {
        void power.suspend({ hibernate }).catch(() => undefined);
      };
      if (delaySeconds === 0) suspend();
      else setTimeout(suspend, delaySeconds * 1000).unref?.();

      const armed = info.armedWake ? `\nArmed wake timer: ${info.armedWake}.` : '';
      const result: SuspendResult = {
        requested: hibernate ? 'hibernate' : 'sleep',
        hibernationEnabled: info.availableStates.some((state) => /hibernate/i.test(state)),
      };
      return `${describeSuspend(result, delaySeconds)}${armed}`;
    },
  };
}

export function makeScheduleWakeTool(power: PowerControl): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'schedule_wake',
        description:
          'Arm this machine to wake itself at a given time, or clear an armed wake. ' +
          'This is the ONLY way software on this machine can bring it back from ' +
          'sleep: once suspended, nothing here is running, so a wake has to be ' +
          'scheduled in advance or sent as a Wake-on-LAN packet from another device. ' +
          'Use get_power_info to report the Wake-on-LAN details.',
        parameters: {
          type: 'object',
          properties: {
            when: {
              type: 'string',
              description:
                'When to wake, as a duration ("90m", "8h"), a clock time ("07:00", ' +
                'meaning the next time it is that time), or "YYYY-MM-DD HH:MM". ' +
                'Omit it only when clearing.',
            },
            clear: {
              type: 'boolean',
              description: 'Remove the armed wake instead of setting one. Defaults to false.',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    permission: 'terminal',
    approval: (args) => ({
      detail:
        args['clear'] === true
          ? 'Clear the armed wake timer.'
          : `Wake this machine at: ${String(args['when'] ?? '(unspecified)')}`,
    }),
    handler: async (args) => {
      if (args['clear'] === true) {
        const removed = await power.clearWakeTimer();
        return removed ? 'Wake timer cleared.' : 'There was no wake timer armed.';
      }
      const when = args['when'];
      if (typeof when !== 'string' || !when.trim()) {
        throw new Error(
          'schedule_wake: `when` is required unless `clear` is true. Use a duration ' +
            '("8h"), a clock time ("07:00"), or "YYYY-MM-DD HH:MM".',
        );
      }
      const target = parseWakeTime(when);
      if (!target) {
        throw new Error(
          `schedule_wake: could not read "${when}" as a time. Use a duration ("90m", "8h"), ` +
            'a clock time ("07:00"), or "YYYY-MM-DD HH:MM". Durations over 14 days are refused.',
        );
      }
      try {
        await power.armWakeTimer(target);
      } catch (err) {
        // The remedy travels with the refusal: a bare "wake timers are disabled"
        // sends the model looking for a setting it cannot find.
        if (err instanceof WakeTimersDisabledError) throw err;
        throw new Error(`schedule_wake: ${(err as Error).message}`);
      }
      return (
        `This machine will wake at ${target.toLocaleString()}. ` +
        'It resumes on its own; VS Code, Forge and any paired chat come back with it.'
      );
    },
  };
}

export function makeGetPowerInfoTool(power: PowerControl): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'get_power_info',
        description:
          "Report this machine's sleep and wake configuration: which sleep states " +
          'it supports, whether a wake timer is armed, and the MAC address and ' +
          'broadcast address a Wake-on-LAN magic packet would have to be sent to. ' +
          'Use it to answer "can this machine be woken remotely" without guessing.',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
    },
    permission: 'read',
    // Read-only and argument-free: nothing here can be steered into a side effect.
    autoApprove: true,
    handler: async () => formatWakeInfo(await power.describeWake()),
  };
}
