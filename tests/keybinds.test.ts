import { describe, expect, it } from "vitest";
import { acceleratorOf, chordOf, defaultKeybindsFor, formatAccelerator, formatChord, keybindInfos, matchKeybind, resolveKeybinds, tabSwitchIndex } from "../src/shared/keybinds.js";

const defaultKeybinds = defaultKeybindsFor(true);

const press = (over: Partial<Parameters<typeof chordOf>[0]>) => ({ key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });

describe("keybinds", () => {
  it("builds chords from the physical key so ⌥3 does not become £", () => {
    expect(chordOf(press({ key: "£", code: "Digit3", metaKey: true, altKey: true }))).toBe("Meta+Alt+Digit3");
    expect(chordOf(press({ key: "t", code: "KeyT", metaKey: true, shiftKey: true }))).toBe("Meta+Shift+T");
    expect(chordOf(press({ key: ",", code: "Comma", metaKey: true }))).toBe("Meta+,");
    expect(chordOf(press({ key: "Enter", code: "Enter", metaKey: true, shiftKey: true }))).toBe("Meta+Shift+Enter");
  });

  it("ignores bare modifier presses", () => {
    expect(chordOf(press({ key: "Meta", code: "MetaLeft", metaKey: true }))).toBeUndefined();
  });

  it("matches overrides over defaults", () => {
    const keybinds = resolveKeybinds({ search: "Ctrl+Space" }, true);
    expect(matchKeybind(keybinds, press({ key: " ", code: "Space", ctrlKey: true }))).toBe("search");
    expect(matchKeybind(keybinds, press({ key: "k", code: "KeyK", metaKey: true }))).toBeUndefined();
    expect(matchKeybind(keybinds, press({ key: "w", code: "KeyW", metaKey: true }))).toBe("tab.close");
    expect(matchKeybind(keybinds, press({ key: "t", code: "KeyT", metaKey: true, shiftKey: true }))).toBe("tab.reopen");
    expect(matchKeybind(keybinds, press({ key: "n", code: "KeyN", metaKey: true, shiftKey: true }))).toBe("tab.newAgent");
    expect(matchKeybind(keybinds, press({ key: "n", code: "KeyN", metaKey: true }))).toBe("window.new");
  });

  it("matches the terminal text size chords, digits coming from the physical key", () => {
    const keybinds = resolveKeybinds({}, true);
    expect(matchKeybind(keybinds, press({ key: "=", code: "Equal", metaKey: true }))).toBe("font.increase");
    expect(matchKeybind(keybinds, press({ key: "-", code: "Minus", metaKey: true }))).toBe("font.decrease");
    expect(matchKeybind(keybinds, press({ key: "0", code: "Digit0", metaKey: true }))).toBe("font.reset");
    // ⌘1-9 focus tabs; only ⌘0 is the size reset.
    expect(matchKeybind(keybinds, press({ key: "1", code: "Digit1", metaKey: true }))).toBeUndefined();
  });

  it("turns arrow chords into electron accelerators", () => {
    expect(acceleratorOf(defaultKeybinds["workspace.next"])).toBe("CommandOrControl+Alt+Right");
    expect(formatChord(defaultKeybinds["workspace.prev"], true)).toBe("⌘⌥←");
  });
  it("turns chords into electron accelerators", () => {
    expect(acceleratorOf("Meta+,")).toBe("CommandOrControl+,");
    expect(acceleratorOf("Meta+Alt+Digit2")).toBe("CommandOrControl+Alt+2");
    expect(acceleratorOf(defaultKeybinds.zen)).toBe("CommandOrControl+Shift+Return");
    expect(acceleratorOf("Ctrl+Tab")).toBe("Control+Tab");
    expect(acceleratorOf("F5")).toBeUndefined();
    expect(acceleratorOf(defaultKeybinds["font.increase"])).toBe("CommandOrControl+=");
    expect(acceleratorOf(defaultKeybinds["font.decrease"])).toBe("CommandOrControl+-");
    expect(acceleratorOf(defaultKeybinds["font.reset"])).toBe("CommandOrControl+0");
  });

  it("formats chords with mac symbols", () => {
    expect(formatChord(defaultKeybinds.zen, true)).toBe("⌘⇧⏎");
    expect(formatChord("Meta+Alt+Digit1", true)).toBe("⌘⌥1");
    expect(formatChord("Ctrl+Space", true)).toBe("⌃space");
    expect(formatChord(defaultKeybinds["font.increase"], true)).toBe("⌘=");
    expect(formatChord(defaultKeybinds["font.reset"], true)).toBe("⌘0");
  });

  it("formats the summon accelerator with mac symbols", () => {
    expect(formatAccelerator("Alt+Space", true)).toBe("⌥space");
    expect(formatAccelerator("CommandOrControl+Shift+Space", true)).toBe("⌘⇧space");
    expect(formatAccelerator(acceleratorOf("Meta+Alt+Digit1") ?? "", true)).toBe("⌘⌥1");
    expect(formatAccelerator("Control+Return", true)).toBe("⌃⏎");
  });

  it("gives every command its own default chord on both platforms", () => {
    for (const mac of [true, false]) {
      const chords = Object.values(defaultKeybindsFor(mac));
      expect(new Set(chords).size).toBe(keybindInfos.length);
    }
  });

  it("keeps Linux defaults off Super and off the shell's plain Ctrl keys and copy/paste", () => {
    for (const chord of Object.values(defaultKeybindsFor(false))) {
      expect(chord).not.toMatch(/^Meta\+/);
      expect(chord).not.toMatch(/^Ctrl\+[A-Z]$/);
      expect(["Ctrl+Shift+C", "Ctrl+Shift+V"]).not.toContain(chord);
    }
  });

  it("matches Linux chords, punctuation by its unshifted key", () => {
    const keybinds = resolveKeybinds({}, false);
    expect(matchKeybind(keybinds, press({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true }))).toBe("search");
    expect(matchKeybind(keybinds, press({ key: "<", code: "Comma", ctrlKey: true, shiftKey: true }))).toBe("settings");
    expect(matchKeybind(keybinds, press({ key: "T", code: "KeyT", ctrlKey: true, altKey: true, shiftKey: true }))).toBe("tab.reopen");
    expect(matchKeybind(keybinds, press({ key: "k", code: "KeyK", ctrlKey: true }))).toBeUndefined();
    expect(acceleratorOf(keybinds["workspace.next"])).toBe("Control+Alt+PageDown");
    expect(formatChord(keybinds["tab.reopen"], false)).toBe("Ctrl+Alt+Shift+T");
    expect(formatAccelerator("CommandOrControl+Shift+Space", false)).toBe("Ctrl+Shift+Space");
  });

  it("switches tabs with ⌘1-9 on macOS and Alt+1-9 elsewhere", () => {
    expect(tabSwitchIndex(press({ key: "3", code: "Digit3", metaKey: true }), true)).toBe(3);
    expect(tabSwitchIndex(press({ key: "3", code: "Digit3", altKey: true }), false)).toBe(3);
    expect(tabSwitchIndex(press({ key: "3", code: "Digit3", altKey: true }), true)).toBeUndefined();
    expect(tabSwitchIndex(press({ key: "0", code: "Digit0", altKey: true }), false)).toBeUndefined();
  });
});
