/** Rebindable keyboard shortcuts. A chord is stored as modifiers and a key
 *  joined by "+", e.g. "Meta+Shift+T" or "Meta+Alt+Digit1". Letters and digits
 *  come from the physical key so ⌥3 (which types "£" on a Mac) still matches. */

export type KeybindCommand =
  | "search" | "settings" | "sidebar" | "window.new"
  | "view.terminal" | "view.board" | "view.agent" | "view.reviews" | "view.activity"
  | "zen" | "presentation"
  | "workspace.next" | "workspace.prev"
  | "tab.new" | "tab.newAgent" | "tab.close" | "tab.reopen" | "tab.next" | "tab.prev"
  | "split.right" | "split.down" | "find" | "composer" | "changes"
  | "font.increase" | "font.decrease" | "font.reset";

export type Keybinds = Record<KeybindCommand, string>;

export interface KeybindInfo {
  id: KeybindCommand;
  label: string;
  group: "Workbench" | "Terminal";
  default: string;
  /** Default off macOS, where Meta is the Super key the desktop keeps for itself.
   *  Terminal-style Ctrl+Shift, so plain Ctrl stays with the shell. */
  linux?: string;
}

export const keybindInfos: KeybindInfo[] = [
  { id: "search", label: "Search sessions, history, commands, settings, themes and repositories", group: "Workbench", default: "Meta+K", linux: "Ctrl+Shift+K" },
  { id: "settings", label: "Open settings", group: "Workbench", default: "Meta+,", linux: "Ctrl+Shift+," },
  { id: "sidebar", label: "Toggle sidebar", group: "Workbench", default: "Meta+B", linux: "Ctrl+Shift+B" },
  { id: "window.new", label: "New window", group: "Workbench", default: "Meta+N", linux: "Ctrl+Shift+N" },
  { id: "view.terminal", label: "Terminal page", group: "Workbench", default: "Meta+Alt+Digit1", linux: "Ctrl+Alt+Digit1" },
  { id: "view.board", label: "Board page", group: "Workbench", default: "Meta+Alt+Digit2", linux: "Ctrl+Alt+Digit2" },
  { id: "view.agent", label: "Agent page", group: "Workbench", default: "Meta+Alt+Digit3", linux: "Ctrl+Alt+Digit3" },
  { id: "view.reviews", label: "Reviews page", group: "Workbench", default: "Meta+Alt+Digit4", linux: "Ctrl+Alt+Digit4" },
  { id: "view.activity", label: "Activity page", group: "Workbench", default: "Meta+Alt+Digit5", linux: "Ctrl+Alt+Digit5" },
  { id: "zen", label: "Toggle Zen view", group: "Workbench", default: "Meta+Shift+Enter", linux: "Ctrl+Shift+Enter" },
  { id: "presentation", label: "Toggle Presentation view", group: "Workbench", default: "Meta+Shift+P", linux: "Ctrl+Shift+P" },
  { id: "workspace.next", label: "Next workspace", group: "Workbench", default: "Meta+Alt+ArrowRight", linux: "Ctrl+Alt+PageDown" },
  { id: "workspace.prev", label: "Previous workspace", group: "Workbench", default: "Meta+Alt+ArrowLeft", linux: "Ctrl+Alt+PageUp" },
  { id: "tab.new", label: "New terminal tab", group: "Terminal", default: "Meta+T", linux: "Ctrl+Shift+T" },
  { id: "tab.newAgent", label: "New tab running the default agent", group: "Terminal", default: "Meta+Shift+N", linux: "Ctrl+Shift+A" },
  { id: "tab.close", label: "Close the active tab", group: "Terminal", default: "Meta+W", linux: "Ctrl+Shift+W" },
  { id: "tab.reopen", label: "Reopen the last closed tab", group: "Terminal", default: "Meta+Shift+T", linux: "Ctrl+Alt+Shift+T" },
  { id: "tab.next", label: "Next tab", group: "Terminal", default: "Ctrl+Tab" },
  { id: "tab.prev", label: "Previous tab", group: "Terminal", default: "Ctrl+Shift+Tab" },
  { id: "split.right", label: "Split right", group: "Terminal", default: "Meta+D", linux: "Ctrl+Shift+D" },
  { id: "split.down", label: "Split down", group: "Terminal", default: "Meta+Shift+D", linux: "Ctrl+Alt+Shift+D" },
  { id: "find", label: "Find in terminal output", group: "Terminal", default: "Meta+F", linux: "Ctrl+Shift+F" },
  { id: "composer", label: "Toggle multiline input", group: "Terminal", default: "Meta+J", linux: "Ctrl+Shift+J" },
  { id: "changes", label: "Toggle the changes panel", group: "Terminal", default: "Meta+E", linux: "Ctrl+Shift+E" },
  { id: "font.increase", label: "Larger terminal text", group: "Terminal", default: "Meta+=", linux: "Ctrl+=" },
  { id: "font.decrease", label: "Smaller terminal text", group: "Terminal", default: "Meta+-", linux: "Ctrl+-" },
  { id: "font.reset", label: "Reset terminal text size", group: "Terminal", default: "Meta+Digit0", linux: "Ctrl+Digit0" },
];

/** Whether this process runs on macOS; the renderer only has navigator, the main process has process. */
export const isMac = /Mac|darwin/.test(globalThis.navigator?.platform ?? (globalThis as { process?: { platform?: string } }).process?.platform ?? "");

export function defaultKeybindsFor(mac: boolean): Keybinds {
  return Object.fromEntries(keybindInfos.map((info) => [info.id, mac ? info.default : (info.linux ?? info.default)])) as Keybinds;
}

export const defaultKeybinds = defaultKeybindsFor(isMac);

/** Fills gaps in a stored override map with the defaults. */
export function resolveKeybinds(overrides: Partial<Keybinds> | undefined, mac = isMac): Keybinds {
  return { ...defaultKeybindsFor(mac), ...overrides };
}

/** The tab position (1-9) a key press switches to: ⌘1-9 on macOS, Alt+1-9 as in GNOME Terminal elsewhere. */
export function tabSwitchIndex(event: KeyPress, mac = isMac): number | undefined {
  const modifier = mac ? event.metaKey && !event.ctrlKey && !event.altKey : event.altKey && !event.ctrlKey && !event.metaKey;
  const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
  return modifier && !event.shiftKey && digit ? Number(digit) : undefined;
}

/** The chord a keyboard event represents, or undefined for a bare modifier press. */
/** The parts of a KeyboardEvent a chord is built from; kept local so this file also compiles for the main process. */
export interface KeyPress { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

// Shift turns these into another character (Ctrl+Shift+, arrives as "<"), so chords keep the unshifted key.
const punctuation: Record<string, string> = { Comma: ",", Period: ".", Equal: "=", Minus: "-", Slash: "/", Semicolon: ";" };

export function chordOf(event: KeyPress): string | undefined {
  if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return undefined;
  const modifiers = [event.metaKey && "Meta", event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift"].filter(Boolean);
  const physical = /^(Digit\d|Key[A-Z])$/.exec(event.code)?.[0];
  const unshifted = event.shiftKey ? punctuation[event.code] : undefined;
  const key = physical ? (physical.startsWith("Key") ? physical.slice(3) : physical) : unshifted ?? (event.key === " " ? "Space" : event.key.length === 1 ? event.key.toUpperCase() : event.key);
  return [...modifiers, key].join("+");
}

export function matchKeybind(keybinds: Keybinds, event: KeyPress): KeybindCommand | undefined {
  const chord = chordOf(event);
  return chord ? (Object.keys(keybinds) as KeybindCommand[]).find((id) => keybinds[id] === chord) : undefined;
}

const symbols: Record<string, string> = { Meta: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Enter: "⏎", Escape: "esc", Backspace: "⌫", Tab: "⇥", Space: "space", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };

const acceleratorParts: Record<string, string> = { Meta: "CommandOrControl", Ctrl: "Control", Enter: "Return", Escape: "Esc", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };

/** "Meta+Alt+Digit1" as the electron accelerator "CommandOrControl+Alt+1". */
export function acceleratorOf(chord: string): string | undefined {
  const parts = chord.split("+").map((part) => acceleratorParts[part] ?? part.replace(/^Digit/, ""));
  return parts.length > 1 ? parts.join("+") : undefined;
}

/** "Meta+Shift+Enter" as "⌘⇧⏎" on macOS, "Ctrl+Shift+Enter" elsewhere. */
export function formatChord(chord: string, mac = isMac): string {
  if (!mac) return chord.split("+").map((part) => part.replace(/^Digit/, "")).join("+");
  return chord.split("+").map((part) => symbols[part] ?? part.replace(/^Digit/, "")).join("");
}

const acceleratorSymbols: Record<string, string> = { CommandOrControl: "⌘", Command: "⌘", Cmd: "⌘", Super: "⌘", Control: "⌃", Option: "⌥", Return: "⏎" };

/** "CommandOrControl+Shift+Space" as "⌘⇧space" for display. The summon hotkey
 *  is stored as an accelerator rather than a chord, so it formats from here. */
export function formatAccelerator(accelerator: string, mac = isMac): string {
  if (!mac) return accelerator.replace(/CommandOrControl|Control/g, "Ctrl");
  return accelerator.split("+").map((part) => acceleratorSymbols[part] ?? symbols[part] ?? part).join("");
}
