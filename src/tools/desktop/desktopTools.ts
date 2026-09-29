/**
 * The Windows desktop tool family (plan §4.2). All tools are `permission:
 * 'desktop'` (deny-by-default) and `advertise: () => process.platform ===
 * 'win32'` (B7: refused at dispatch on other platforms). `desktop_capture`
 * carries `requiresVision` (B8 single source). Coordinate actions require a
 * `capture_id` — there is no implicit global screen.
 *
 * Cloud-model capture gate (§4.7): a monitor capture on a cloud vision model
 * sends the user's screen to that provider; the approval names it.
 */
import type { ForgeConfig } from '../../config/types';
import type { ContentPart } from '../../llm/types';
import type { MultimodalToolResult, RegisteredTool } from '../ToolRegistry';
import { saveScreenshot, visionRefusal } from '../browser/browserTools';
import { getDesktopDriver } from './PowerShellDesktopDriver';
import {
  captureApproval,
  cloudMonitorApproval,
  consequentialApproval,
  systemChordApproval,
} from './desktopApprovals';
import type { CoordSpace } from './coordinateTransform';

type GetConfig = () => ForgeConfig;

const isWin = () => process.platform === 'win32';

const num = (args: Record<string, unknown>, key: string): number | undefined =>
  typeof args[key] === 'number' ? (args[key] as number) : undefined;
const str = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === 'string' && (args[key] as string) !== '' ? (args[key] as string) : undefined;
const coordSpace = (args: Record<string, unknown>): CoordSpace | undefined => {
  const v = args.coord_space;
  return v === 'norm_1000' ? 'norm_1000' : v === 'image_px' ? 'image_px' : undefined;
};

/**
 * Factory for the whole desktop tool family (plan §4.2). One
 * `PowerShellDesktopDriver` (the singleton) is shared by every tool.
 * `advertise: isWin` keeps the family invisible on non-Windows platforms (B7).
 */
export function makeDesktopTools(getConfig: GetConfig): RegisteredTool[] {
  const driver = getDesktopDriver();
  const monitorApproval = cloudMonitorApproval(getConfig);
  const chordApproval = systemChordApproval();
  const clickApproval = consequentialApproval('desktop_click');
  const typeApproval = consequentialApproval('desktop_type');

  return [
    // ── desktop_capture ──────────────────────────────────────────────────────
    {
      definition: {
        type: 'function',
        function: {
          name: 'desktop_capture',
          description:
            'Capture a window (by title) or a full monitor as an image and return it inline. ' +
            'A window capture binds the approved control target (HWND+pid) and returns a capture_id ' +
            'that coordinate actions reference. A monitor capture is read-only (no coordinate actions). ' +
            'The text states the actual image size, DPI scale, origin, and coord_space.',
          parameters: {
            type: 'object',
            properties: {
              window_title: {
                type: 'string',
                description: 'Title of the window to capture (exact or substring match).',
              },
              monitor: {
                type: 'number',
                description:
                  'Monitor index (0 = primary) for a full-screen capture. Requires approval on cloud models.',
              },
              kind: {
                type: 'string',
                enum: ['window', 'monitor'],
                description:
                  'Capture kind. Defaults to window when window_title is set, monitor when monitor is set.',
              },
            },
            additionalProperties: false,
          },
        },
      },
      permission: 'desktop',
      autoApprove: true,
      advertise: isWin,
      requiresVision: (name) => visionRefusal(name),
      approval: captureApproval(driver, monitorApproval),
      handler: async (args, toolCtx): Promise<MultimodalToolResult> => {
        const title = str(args, 'window_title');
        const monitorIdx = num(args, 'monitor');
        const kind =
          (args.kind as string) ??
          (title ? 'window' : monitorIdx !== undefined ? 'monitor' : 'window');
        if (kind === 'window' && !title)
          throw new Error('desktop_capture: window_title is required for a window capture');
        if (kind === 'monitor' && monitorIdx === undefined)
          throw new Error('desktop_capture: monitor index is required for a monitor capture');
        const target =
          kind === 'window'
            ? { kind: 'window' as const, title: title! }
            : { kind: 'monitor' as const, index: monitorIdx ?? 0 };
        const cap = await driver.capture(target, {
          allowNewApproval: title !== undefined && !driver.coversTitle(title),
        });
        const saved = await saveScreenshot(toolCtx?.conversationId, cap.png);
        const originNote = `origin=(${cap.origin.x},${cap.origin.y})`;
        const kindNote =
          cap.kind === 'window'
            ? `window "${cap.title}" approved (HWND ${cap.approvedHwnd}, pid ${cap.approvedPid})`
            : 'monitor (read-only; coordinate actions require a window capture)';
        const text =
          `Desktop capture: ${kindNote}, ${cap.width}×${cap.height} px, ` +
          `dpi_scale=${cap.dpiScale}, ${originNote}, coord_space=image_px. ` +
          `capture_id=${cap.captureId}. Saved to ${saved}.`;
        const content: ContentPart[] = [
          { type: 'text', text },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${cap.png.toString('base64')}` },
          },
        ];
        return { text, content };
      },
    },

    // ── desktop_windows ──────────────────────────────────────────────────────
    {
      definition: {
        type: 'function',
        function: {
          name: 'desktop_windows',
          description:
            'List top-level windows as {id, title, rect} (physical pixels). Use the title in desktop_focus_window or desktop_capture.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      permission: 'desktop',
      autoApprove: true,
      advertise: isWin,
      handler: async () => {
        const windows = await driver.listWindows();
        if (windows.length === 0) return 'No visible windows found.';
        return windows
          .map(
            (w) =>
              `${w.id}: "${w.title}" (${w.rect.x},${w.rect.y} ${w.rect.width}×${w.rect.height})`,
          )
          .join('\n');
      },
    },

    // ── desktop_focus_window ─────────────────────────────────────────────────
    {
      definition: {
        type: 'function',
        function: {
          name: 'desktop_focus_window',
          description:
            'Focus a window by title or id and approve it as the control target. ' +
            'Subsequent input actions are foreground-checked against this window. ' +
            'Always refuses VS Code, UAC/secure desktop, and the taskbar.',
          parameters: {
            type: 'object',
            properties: {
              window_title: {
                type: 'string',
                description: 'Title of the window to focus (exact or substring match).',
              },
              window_id: {
                type: 'string',
                description: 'The HWND (from desktop_windows) to focus.',
              },
            },
            additionalProperties: false,
          },
        },
      },
      permission: 'desktop',
      advertise: isWin,
      approval: (args) => ({
        detail: `Approve controlling "${str(args, 'window_title') ?? str(args, 'window_id') ?? '?'}" (binds HWND+pid)`,
      }),
      handler: async (args) => {
        const title = str(args, 'window_title');
        const id = str(args, 'window_id');
        if (!title && !id)
          throw new Error('desktop_focus_window: window_title or window_id is required');
        const target = title
          ? { kind: 'window' as const, title }
          : { kind: 'windowId' as const, id: id! };
        const w = await driver.focusWindow(target);
        return `Focused and approved "${w.title}" (HWND ${w.id}). Input actions are now foreground-checked against this window.`;
      },
    },

    // ── desktop_move_mouse ───────────────────────────────────────────────────
    {
      definition: {
        type: 'function',
        function: {
          name: 'desktop_move_mouse',
          description:
            "Move the cursor to x,y in the capture_id's coordinate space. " +
            'Requires a window capture (capture_id from desktop_capture of a window).',
          parameters: {
            type: 'object',
            properties: {
              x: { type: 'number', description: "X coordinate in the capture's coord_space." },
              y: { type: 'number', description: "Y coordinate in the capture's coord_space." },
              capture_id: { type: 'string', description: 'The capture_id from desktop_capture.' },
              coord_space: {
                type: 'string',
                enum: ['image_px', 'norm_1000'],
                description: 'Coordinate space (default image_px).',
              },
            },
            required: ['x', 'y', 'capture_id'],
            additionalProperties: false,
          },
        },
      },
      permission: 'desktop',
      autoApprove: true,
      advertise: isWin,
      handler: async (args) => {
        const x = num(args, 'x')!;
        const y = num(args, 'y')!;
        const capId = str(args, 'capture_id')!;
        await driver.moveMouse(x, y, capId, coordSpace(args));
        return `Moved cursor to (${x},${y}) in ${coordSpace(args) ?? 'image_px'}.`;
      },
    },

    // ── desktop_click ────────────────────────────────────────────────────────
    {
      definition: {
        type: 'function',
        function: {
          name: 'desktop_click',
          description:
            "Click (or double-click / right-click) at x,y in the capture_id's coordinate space. " +
            'Set consequential=true if the click submits a form, makes a purchase, sends a message, or deletes data.',
          parameters: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              button: {
                type: 'string',
                enum: ['left', 'right', 'middle'],
                description: 'Mouse button (default left).',
              },
              clicks: { type: 'number', description: '1 = click, 2 = double-click (default 1).' },
              capture_id: { type: 'string' },
              coord_space: { type: 'string', enum: ['image_px', 'norm_1000'] },
              consequential: {
                type: 'boolean',
                description:
                  'Set true if this click is consequential (submit, purchase, send, delete).',
              },
            },
            required: ['x', 'y', 'capture_id'],
            additionalProperties: false,
          },
        },
      },
      permission: 'desktop',
      advertise: isWin,
      approval: clickApproval,
      handler: async (args) => {
        const x = num(args, 'x')!;
        const y = num(args, 'y')!;
        const capId = str(args, 'capture_id')!;
        const button = (args.button as string) ?? 'left';
        const clicks = num(args, 'clicks') ?? 1;
        await driver.click(
          x,
          y,
          { button: button as 'left' | 'right' | 'middle', clicks },
          capId,
          coordSpace(args),
        );
        return `Clicked (${button}, ${clicks}×) at (${x},${y}) in ${coordSpace(args) ?? 'image_px'}.`;
      },
    },

    // ── desktop_drag ─────────────────────────────────────────────────────────
    {
      definition: {
        type: 'function',
        function: {
          name: 'desktop_drag',
          description:
            "Drag from (from_x,from_y) to (to_x,to_y) in the capture_id's coordinate space. " +
            "The button is released in the driver's finally block (B3).",
          parameters: {
            type: 'object',
            properties: {
              from_x: { type: 'number' },
              from_y: { type: 'number' },
              to_x: { type: 'number' },
              to_y: { type: 'number' },
              capture_id: { type: 'string' },
              coord_space: { type: 'string', enum: ['image_px', 'norm_1000'] },
            },
            required: ['from_x', 'from_y', 'to_x', 'to_y', 'capture_id'],
            additionalProperties: false,
          },
        },
      },
      permission: 'desktop',
      advertise: isWin,
      handler: async (args) => {
        const from = { x: num(args, 'from_x')!, y: num(args, 'from_y')! };
        const to = { x: num(args, 'to_x')!, y: num(args, 'to_y')! };
        const capId = str(args, 'capture_id')!;
        await driver.drag(from, to, capId, coordSpace(args));
        return `Dragged from (${from.x},${from.y}) to (${to.x},${to.y}) in ${coordSpace(args) ?? 'image_px'}.`;
      },
    },

    // ── desktop_scroll ───────────────────────────────────────────────────────
    {
      definition: {
        type: 'function',
        function: {
          name: 'desktop_scroll',
          description:
            "Scroll at (x,y) in the capture_id's coordinate space by (delta_x, delta_y). " +
            'Positive delta_y scrolls down; positive delta_x scrolls right.',
          parameters: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              delta_x: { type: 'number', description: 'Horizontal scroll amount (default 0).' },
              delta_y: { type: 'number', description: 'Vertical scroll amount (default 0).' },
              capture_id: { type: 'string' },
              coord_space: { type: 'string', enum: ['image_px', 'norm_1000'] },
            },
            required: ['x', 'y', 'capture_id'],
            additionalProperties: false,
          },
        },
      },
      permission: 'desktop',
      autoApprove: true,
      advertise: isWin,
      handler: async (args) => {
        const x = num(args, 'x')!;
        const y = num(args, 'y')!;
        const delta = { x: num(args, 'delta_x') ?? 0, y: num(args, 'delta_y') ?? 0 };
        const capId = str(args, 'capture_id')!;
        await driver.scroll(x, y, delta, capId, coordSpace(args));
        return `Scrolled (${delta.x},${delta.y}) at (${x},${y}) in ${coordSpace(args) ?? 'image_px'}.`;
      },
    },

    // ── desktop_type ─────────────────────────────────────────────────────────
    {
      definition: {
        type: 'function',
        function: {
          name: 'desktop_type',
          description:
            'Type text into the approved target window (KEYEVENTF_UNICODE). ' +
            'Set consequential=true if the text submits a form, sends a message, or deletes data.',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The text to type.' },
              consequential: {
                type: 'boolean',
                description: 'Set true if this text is consequential.',
              },
            },
            required: ['text'],
            additionalProperties: false,
          },
        },
      },
      permission: 'desktop',
      advertise: isWin,
      approval: typeApproval,
      handler: async (args) => {
        const text = str(args, 'text')!;
        await driver.typeText(text);
        return `Typed ${text.length} character(s) into the approved target window.`;
      },
    },

    // ── desktop_press ────────────────────────────────────────────────────────
    {
      definition: {
        type: 'function',
        function: {
          name: 'desktop_press',
          description:
            'Press a chord of key names (e.g. ["ctrl","c"]) on the approved target window. ' +
            'System chords (win+*, alt+f4, ctrl+alt+*) always require explicit confirmation.',
          parameters: {
            type: 'object',
            properties: {
              keys: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Key names in press order. Supported: ctrl, alt, shift, win, enter, tab, esc, escape, ' +
                  'backspace, delete, del, space, up, down, left, right, home, end, pageup, pagedown, ' +
                  'insert, f1-f12.',
              },
            },
            required: ['keys'],
            additionalProperties: false,
          },
        },
      },
      permission: 'desktop',
      advertise: isWin,
      approval: chordApproval,
      handler: async (args) => {
        const keys = Array.isArray(args.keys) ? (args.keys as string[]) : [];
        if (keys.length === 0) throw new Error('desktop_press: keys array is required');
        await driver.press(keys);
        return `Pressed [${keys.join('+')}] on the approved target window.`;
      },
    },
  ];
}
