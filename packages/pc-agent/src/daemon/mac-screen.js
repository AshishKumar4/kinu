// Kinu PC agent — a Mac's screen, from ScreenCaptureKit (1014-t).
//
// A helper in Swift captures the main display with ScreenCaptureKit, encodes
// its frames as JPEG, and posts the viewer's keys and pointer as the Mac's own
// events (CGEvent); it speaks screen-helper.js's protocol. `kinu desktop share`
// compiles it with the Command Line Tools' swiftc into a path that stays put
// across daemon updates, because macOS's own prompts, Screen Recording and
// Accessibility, grant the helper, and a rebuilt one asks again. It is rebuilt
// only when its source changes. A Mac with no compiler shows the one step that
// fixes that; one older than ScreenCaptureKit (macOS 12.3) shares nothing.
//
// No Mac runs in this repository's checks: the helper is proved by the Mac
// proof on the owner's machine (packages/pc-agent/scripts/mac-held-proof.sh),
// and until it has passed there a Mac reports no screen (`MAC_SCREEN_PROVEN`).
'use strict';

const crypto = require('node:crypto');

const fs = require('node:fs');

const os = require('node:os');

const path = require('node:path');

const { createHelperSource } = require('./screen-helper.js');

const MAC_SCREEN_SWIFT = String.raw`
// Kinu's screen helper for macOS, run by the device daemon. Its stdout is the Linux helper's records: a big-endian
// u32 length, a kind byte (0 an event in JSON, 1 a frame), then the record; a frame is its u16 width and height and
// its JPEG. Its stdin is a line the daemon sends first (a Linux helper's restore token, unused here), then one JSON
// command a line: a key by its macOS key code, the pointer's position in frame pixels, a button, a wheel turn.
import ApplicationServices
import CoreGraphics
import CoreImage
import CoreMedia
import Foundation
import ImageIO
import ScreenCaptureKit

let framesPerSecond: Int32 = 15
let jpegQuality = 0.7
let output = DispatchQueue(label: "run.kinu.screen.output")

func record(_ kind: UInt8, _ payload: Data) {
  var length = UInt32(payload.count).bigEndian
  var bytes = Data(bytes: &length, count: 4)
  bytes.append(kind)
  bytes.append(payload)
  output.sync { FileHandle.standardOutput.write(bytes) }
}

func say(_ event: [String: Any]) {
  if let json = try? JSONSerialization.data(withJSONObject: event) { record(0, json) }
}

func fail(_ why: String, _ code: Int32 = 1) -> Never {
  say(["type": "failed", "why": why])
  exit(code)
}

/// Screen Recording and Accessibility, each asked for once in macOS's own prompt; true when both are held.
func permitted(asking: Bool) -> Bool {
  let recording = asking ? CGRequestScreenCaptureAccess() : CGPreflightScreenCaptureAccess()
  let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: asking] as CFDictionary
  let accessibility = AXIsProcessTrustedWithOptions(options)
  return recording && accessibility
}

func mainDisplay() async -> SCDisplay {
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
      fail("this Mac has no display to share")
    }
    return display
  } catch {
    fail("macOS gave no screen to share: \(error.localizedDescription)")
  }
}

/// The main display's frames, as JPEG records, while the daemon reads them.
final class Frames: NSObject, SCStreamOutput, SCStreamDelegate {
  let context = CIContext()

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sampleBuffer.isValid, let pixels = sampleBuffer.imageBuffer else { return }
    let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]]
    guard let raw = attachments?.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
    let quality = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
    guard let jpeg = context.jpegRepresentation(
      of: CIImage(cvPixelBuffer: pixels), colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, options: [quality: jpegQuality]) else { return }
    var size = Data()
    var width = UInt16(CVPixelBufferGetWidth(pixels)).bigEndian
    var height = UInt16(CVPixelBufferGetHeight(pixels)).bigEndian
    size.append(Data(bytes: &width, count: 2))
    size.append(Data(bytes: &height, count: 2))
    record(1, size + jpeg)
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fail("the screen stream stopped: \(error.localizedDescription)")
  }
}

/// The viewer's input, posted as the Mac's own events.
final class Input {
  let display: SCDisplay
  let pixels: (width: Int, height: Int)
  var position = CGPoint.zero
  var held: Set<Int> = []
  var flags: CGEventFlags = []

  init(display: SCDisplay, pixels: (width: Int, height: Int)) {
    self.display = display
    self.pixels = pixels
  }

  static let modifiers: [Int: CGEventFlags] = [
    0x38: .maskShift, 0x3C: .maskShift, 0x3B: .maskControl, 0x3E: .maskControl,
    0x3A: .maskAlternate, 0x3D: .maskAlternate, 0x37: .maskCommand, 0x36: .maskCommand, 0x39: .maskAlphaShift,
  ]

  func key(_ code: Int, _ down: Bool) {
    if let flag = Input.modifiers[code] {
      if down { flags.insert(flag) } else { flags.remove(flag) }
    }
    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: down) else { return }
    event.flags = flags
    event.post(tap: .cghidEventTap)
  }

  func motion(_ x: Double, _ y: Double) {
    let frame = display.frame
    position = CGPoint(x: frame.minX + x * frame.width / Double(max(pixels.width, 1)), y: frame.minY + y * frame.height / Double(max(pixels.height, 1)))
    let dragging: (CGEventType, CGMouseButton)? = held.contains(0x110) ? (.leftMouseDragged, .left)
      : held.contains(0x111) ? (.rightMouseDragged, .right) : held.contains(0x112) ? (.otherMouseDragged, .center) : nil
    let (type, button) = dragging ?? (.mouseMoved, .left)
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: position, mouseButton: button)?.post(tap: .cghidEventTap)
  }

  func button(_ code: Int, _ down: Bool) {
    let kinds: [Int: (CGEventType, CGEventType, CGMouseButton)] = [
      0x110: (.leftMouseDown, .leftMouseUp, .left), 0x111: (.rightMouseDown, .rightMouseUp, .right), 0x112: (.otherMouseDown, .otherMouseUp, .center),
    ]
    guard let kind = kinds[code] else { return }
    if down { held.insert(code) } else { held.remove(code) }
    CGEvent(mouseEventSource: nil, mouseType: down ? kind.0 : kind.1, mouseCursorPosition: position, mouseButton: kind.2)?.post(tap: .cghidEventTap)
  }

  func scroll(_ axis: Int, _ steps: Int) {
    // RFB's wheel up is a negative step; macOS's is a positive line.
    let lines = Int32(-steps)
    CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: axis == 0 ? lines : 0, wheel2: axis == 1 ? lines : 0, wheel3: 0)?
      .post(tap: .cghidEventTap)
  }

  func apply(_ command: [String: Any]) {
    switch command["type"] as? String {
    case "key": key(command["code"] as? Int ?? -1, command["down"] as? Bool ?? false)
    case "motion": motion(command["x"] as? Double ?? 0, command["y"] as? Double ?? 0)
    case "button": button(command["button"] as? Int ?? 0, command["down"] as? Bool ?? false)
    case "scroll": scroll(command["axis"] as? Int ?? 0, command["steps"] as? Int ?? 0)
    default: break
    }
  }
}

func serve() async {
  guard permitted(asking: false) else {
    fail("this Mac no longer lets Kinu's screen helper record the screen or post input: run kinu desktop share on it", 3)
  }
  let display = await mainDisplay()
  let pixels = (width: CGDisplayPixelsWide(display.displayID), height: CGDisplayPixelsHigh(display.displayID))
  let configuration = SCStreamConfiguration()
  configuration.width = pixels.width
  configuration.height = pixels.height
  configuration.minimumFrameInterval = CMTime(value: 1, timescale: framesPerSecond)
  configuration.pixelFormat = kCVPixelFormatType_32BGRA
  configuration.showsCursor = true
  let frames = Frames()
  let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: configuration, delegate: frames)
  do {
    try stream.addStreamOutput(frames, type: .screen, sampleHandlerQueue: DispatchQueue(label: "run.kinu.screen.frames"))
    try await stream.startCapture()
  } catch {
    fail("the screen stream did not start: \(error.localizedDescription)")
  }
  say(["type": "ready", "width": pixels.width, "height": pixels.height, "token": "permission"])
  let input = Input(display: display, pixels: pixels)
  while let line = readLine() {
    guard let data = line.data(using: .utf8), let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
    DispatchQueue.main.async { input.apply(command) }
  }
  try? await stream.stopCapture()
  exit(0)
}

func main() async {
  let mode = CommandLine.arguments.dropFirst().first ?? ""
  switch mode {
  case "probe":
    say(["type": "probed", "ok": true])
  case "share":
    say(["type": "asking"])
    guard permitted(asking: true) else {
      fail("allow Kinu's screen helper under System Settings › Privacy & Security, in Screen Recording and in Accessibility, then run kinu desktop share again", 3)
    }
    let display = await mainDisplay()
    say(["type": "ready", "width": CGDisplayPixelsWide(display.displayID), "height": CGDisplayPixelsHigh(display.displayID), "token": "permission"])
  case "serve":
    // The first line is the daemon's token line, which a Mac's helper has no use for.
    _ = readLine()
    await serve()
  default:
    fail("usage: probe | share | serve")
  }
  exit(0)
}

Task { await main() }
dispatchMain()
`;

const NO_COMPILER = 'Install the Command Line Tools (xcode-select --install), then run kinu desktop share on this Mac.';

/** Turned on once the Mac proof's screen section passes on a Mac: the helper has been parsed, never compiled or run. */
const MAC_SCREEN_PROVEN = false;

/** ScreenCaptureKit came with macOS 12.3, Darwin 21.4. */
const FIRST_DARWIN = [21, 4];

/** The compiler's own words past this many lines are not the reason a build failed. */
const BUILD_LINES = 3;

/** macOS's key codes (Carbon's kVK_* for the ANSI layout), by the X keysym RFB carries; a shifted symbol is its key. */
const KEY_CODES = new Map([
  ['a', 0], ['s', 1], ['d', 2], ['f', 3], ['h', 4], ['g', 5], ['z', 6], ['x', 7], ['c', 8], ['v', 9],
  ['b', 11], ['q', 12], ['w', 13], ['e', 14], ['r', 15], ['y', 16], ['t', 17], ['o', 31], ['u', 32], ['i', 34], ['p', 35], ['l', 37],
  ['j', 38], ['k', 40], ['n', 45], ['m', 46],
  ['1', 18], ['2', 19], ['3', 20], ['4', 21], ['6', 22], ['5', 23], ['9', 25], ['7', 26], ['8', 28], ['0', 29],
  ['=', 24], ['-', 27], [']', 30], ['[', 33], ['\'', 39], [';', 41], ['\\', 42], [',', 43], ['/', 44], ['.', 47], ['`', 50], [' ', 49],
  ['!', 18], ['@', 19], ['#', 20], ['$', 21], ['%', 23], ['^', 22], ['&', 26], ['*', 28], ['(', 25], [')', 29], ['_', 27], ['+', 24],
  ['{', 33], ['}', 30], ['|', 42], [':', 41], ['"', 39], ['<', 43], ['>', 47], ['?', 44], ['~', 50],
].map(([key, code]) => [key.codePointAt(0), code]));

const SPECIAL_CODES = new Map([
  [0xff08, 51], [0xff09, 48], [0xff0d, 36], [0xff1b, 53], [0xffff, 117], [0xff50, 115], [0xff51, 123], [0xff52, 126],
  [0xff53, 124], [0xff54, 125], [0xff55, 116], [0xff56, 121], [0xff57, 119], [0xff63, 114], [0xff8d, 76],
  [0xffbe, 122], [0xffbf, 120], [0xffc0, 99], [0xffc1, 118], [0xffc2, 96], [0xffc3, 97], [0xffc4, 98], [0xffc5, 100],
  [0xffc6, 101], [0xffc7, 109], [0xffc8, 103], [0xffc9, 111],
  // Shift, Control, Caps Lock, then Meta and Super as Command, Alt as Option: left before right.
  [0xffe1, 56], [0xffe2, 60], [0xffe3, 59], [0xffe4, 62], [0xffe5, 57], [0xffe7, 55], [0xffe8, 54], [0xffe9, 58], [0xffea, 61],
  [0xffeb, 55], [0xffec, 54],
]);

/** A keysym's macOS key code; null for one the ANSI layout has no key for. An upper-case letter is its key. */
function macKeyCode(keysym) {
  const letter = keysym >= 0x41 && keysym <= 0x5a ? keysym + 0x20 : keysym;

  return KEY_CODES.get(letter) ?? SPECIAL_CODES.get(keysym) ?? null;
}

function digest(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Whether this Mac's Darwin is ScreenCaptureKit's or later. */
function hasScreenCaptureKit(release) {
  const [major = 0, minor = 0] = release.split('.').map(Number);

  return major > FIRST_DARWIN[0] || (major === FIRST_DARWIN[0] && minor >= FIRST_DARWIN[1]);
}

/**
 * A Mac's screen source. The helper is built into `home`/desktop on the share,
 * its source's digest beside it; `spawn` runs the compiler as it runs the
 * helper, and `release` is Darwin's version, both a test's own in tests.
 */
function createMacSource({ home, log, spawn = Bun.spawn, release = os.release(), proven = MAC_SCREEN_PROVEN, ...options }) {
  const directory = path.join(home, 'desktop');
  const binary = path.join(directory, 'kinu-screen');
  const stamp = `${binary}.sha256`;

  const current = () => fs.existsSync(binary) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === digest(MAC_SCREEN_SWIFT);

  /** What a run of `argv` exited with and said, its words being its last lines on stderr. */
  async function ran(argv) {
    try {
      const child = spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

      return { code, said: stderr.trim().split('\n').slice(-BUILD_LINES).join(' ') };
    } catch (err) {
      return { code: -1, said: err instanceof Error ? err.message : String(err) };
    }
  }

  return createHelperSource({
    home,
    log,
    spawn,
    command: (mode) => [binary, mode],
    keyCommand: (down, keysym) => {
      const code = macKeyCode(keysym);

      return code === null ? null : { type: 'key', code, down };
    },
    async probe() {
      if (!proven) return { ok: false, why: "the Mac screen helper has not passed the Mac proof yet" };

      if (!hasScreenCaptureKit(release)) return { ok: false, why: `macOS on Darwin ${release} predates ScreenCaptureKit (macOS 12.3)` };
      const found = await ran(['xcrun', '--find', 'swiftc']);

      return found.code === 0 ? { ok: true, why: '' } : { ok: false, why: `no swiftc: ${found.said}`, setup: NO_COMPILER };
    },
    // Built when its source changed since the last share, never otherwise: a rebuilt helper asks macOS's prompts again.
    async prepare() {
      if (current()) return { ok: true, why: '' };
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const source = `${binary}.swift`;

      fs.writeFileSync(source, MAC_SCREEN_SWIFT, { mode: 0o600 });
      const built = await ran(['xcrun', 'swiftc', '-O', '-swift-version', '5', '-o', binary, source]);

      if (built.code !== 0) return { ok: false, why: `the screen helper did not build: ${built.said}` };
      fs.writeFileSync(stamp, `${digest(MAC_SCREEN_SWIFT)}\n`, { mode: 0o600 });

      return { ok: true, why: '' };
    },
    ...options,
  });
}

module.exports = { createMacSource, macKeyCode };
