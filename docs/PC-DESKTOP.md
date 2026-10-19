# A connected PC's desktop and shell

Design for the owner's review, 2026-10-19. Requests 1014-t ("a connected PC's desktop", m134) and 1019-aa ("one
experience across the computer, PCs and the workspace, with desktop support for those that offer", m067, m134, #99).
The wireframe is the gallery's `workspaceshell` frame with `&pc=granted&pcdesktop=ready|setup|permission`; its
screenshots, dark and light, desktop and phone, are on the review page this note is published with.

## What the owner sees

A PC the workspace holds is a machine in the Environment column, like the computer.

- **Shell.** Its tabs are named terminal sessions. They use the computer's strip, so the PC gets the same new, rename,
  close and split controls. A session stays open while no pane shows it, and it comes back by name and folder. Today a
  PC has one shell, and it ends when its pane closes (`device-terminal.ts`, `paneClosed`). A PC whose daemon predates
  named sessions keeps that one shell.
- **Desktop.** A PC that can share its screen gets a Desktop tab beside its sessions. The tab shows the PC's screen in
  the same client as the computer's, at the PC's own size, and can expand over the workspace the same way. A PC that
  isn't ready yet shows, where its screen would be, the one step on the PC that opens it:
  - **setup**: something on the PC is missing. The daemon names it, for example "Install the Command Line Tools:
    xcode-select --install".
  - **permission**: the PC is showing its own prompt, and the screen opens once someone at the PC allows it.
  - A PC with no screen to share (no graphical session, or sharing never turned on) has no Desktop tab at all.

The device reports which of these applies in each `hello` (`DeviceDesktopSchema`,
`packages/core/src/execution/device-desktop.ts`), and `kinu desktop share` reconnects it so the change shows at once. The
hub holds it on the device's live socket, as it holds the device's being online, so nothing of it is stored: an offline
PC has no screen to open. The client reads it from the device's roster row (`desktop`). A daemon older than the screen speaks device protocol 3, which
the hub serves nothing on: it is pushed the update, as every daemon a protocol behind is.

## How the screen gets here

There is one stream, RFB, the protocol the Environment's desktop client already speaks (`public/kasmvnc`). The browser
opens `/api/workspaces/<workspace>/devices/<device>/desktop` (`desktopClientUrl(at, workspace, device)`). It is gated as
the computer's desktop is: the owner's session plus this workspace's grant on the device. The owner's UserDO relays the
stream over the device tunnel to the daemon, which serves RFB itself. No screen server listens on the PC, on loopback
or anywhere else.

Over the tunnel:
- `screenOpen` is a new method (JSON, as every method is), on device protocol 4: the hub numbers a stream, and the
  daemon answers once the stream is open. `screenClose` is a JSON frame from either side, with the reason when the PC
  ends it. One stream at a time: a second open ends the first ("the screen opened in another tab").
- The screen's bytes cross as **binary WebSocket messages**, never text: each is a 1-byte kind (data), the stream's
  number as a big-endian u32, then up to 64 KiB of RFB. Both ends of the tunnel are WebSockets that carry binary (the
  UserDO's hibernatable socket, `webSocketMessage(ws, string | ArrayBuffer)`, and Bun's client), and so does the
  browser's socket to the UserDO. The stream number drops bytes a closed stream left in flight.
- RFB paces itself: the client asks for each framebuffer update, so the daemon sends a frame only when the viewer can
  take one, and a slow tunnel slows the frame rate, not memory.
- A screen hub sits beside `DeviceTerminalHub` (`device-screen.ts`). It pairs the browser's socket with the daemon's
  stream, one viewer to a stream, and relays the bytes unread. Bytes for a stream it no longer holds close that stream
  on the PC, and a stream no viewer speaks on for 30 seconds stops capturing.
- The daemon's RFB server (`packages/pc-agent/src/daemon/screen.js`) speaks RFB 3.8 with no RFB security: the route
  already proved the owner and the workspace's grant. It sends each frame as Tight, JPEG when the source gives JPEG and
  deflated pixels otherwise, and reads the Environment client's own dialect. KasmVNC's client widens the pointer event
  to 11 bytes, sends messages of its own at connect, maps the pointer by ExtendedDesktopSize, shows a one-rectangle
  update only when the next arrives unless it ends with LastRect, and draws Raw rectangles from the wrong offset. Each
  was measured against the vendored client in Chrome (`tests/browser/pc-desktop-client.test.ts`).

Binary is a protocol change at the two ends' dispatch, and nowhere else. Today the hub decodes every message from a
device as text before it parses it (`user-do.ts`, `webSocketMessage`), and so does the daemon (`index.js`, its socket's `message` listener); each
gains a binary branch for screen data. No existing frame changes, and no daemon or hub of an earlier release ever meets a
binary frame: the hub opens a screen only on a daemon whose `hello` reports one, and only such a daemon sends one.

Where the daemon's screen comes from depends on the system:

- **macOS: a small screen helper the daemon runs, speaking to it over stdio.** It captures with ScreenCaptureKit and
  drives input with `CGEventPost`, and the daemon turns that into RFB as it does on Linux.
  - It ships as Swift source in the release. `kinu desktop share` compiles it with `swiftc` into
    `~/.kinu/desktop/kinu-screen`, a path that stays put across daemon updates, so macOS keeps the permissions it gave.
  - **setup** means there is no `swiftc` (the Command Line Tools: `xcode-select --install`).
  - **permission** is macOS's own Screen Recording and Accessibility prompts. They attach to the helper, and a rebuilt
    helper asks again.
  - Rejected: relaying the system's Screen Sharing. It would make Kinu hold a VNC password for the Mac, and it leaves a
    VNC server listening on TCP 5900. The Mac proof (`packages/pc-agent/scripts/mac-held-proof.sh`) measures what that
    server binds to.
- **Linux: the daemon serves RFB itself, through the desktop portal.** The system's own server can't be relayed:
  GNOME 50.1's gnome-remote-desktop speaks RDP only. Measured on the workstation: `grdctl status` lists RDP and no VNC.
  The usual VNC servers aren't installed by default either (x11vnc and wayvnc are absent there).
  - Screen and input go through `org.freedesktop.portal.ScreenCast` and `RemoteDesktop`, with a `persist_mode` 2
    restore token so the PC asks only once.
  - Frames come from the system's GStreamer (`pipewiresrc ! videoconvert ! jpegenc`; present on the workstation,
    pipewiresrc 1.6.2) and are sent as RFB Tight rectangles with JPEG.
  - Input becomes the portal's `NotifyPointerMotionAbsolute`, `NotifyPointerButton` and `NotifyKeyboardKeysym`.
  - **permission** is the portal's own dialog on the PC. **setup** means there is no portal or no GStreamer.
- **Windows**: none. The daemon doesn't run there.

## The shell

- The daemon keeps named PTY sessions per workspace. A session lives while no pane is attached, holding a bounded
  scrollback that it replays when a pane attaches again.
- New methods `ptyList`, `ptyRename` and `ptyClose` mirror the computer's `terminalSessions` calls. They feed the same
  `TerminalSession` rows the strip reads.
- A daemon restart ends a PC's shells. Each comes back as a fresh shell in its folder under its name, as the computer's
  do after a restart (D90).
- Keying by workspace keeps a workspace from attaching to another workspace's sessions on the same PC.

## Decisions for the owner

Each has a recommendation, which is the default unless the owner says otherwise.

1. **The screen escapes the sandbox.** Typing on a desktop drives the whole machine, whatever roots the workspace was
   given. Proposed:
   - A PC offers its Desktop only after the owner turns sharing on at that PC (`kinu desktop share`), on top of the
     system's own consent (macOS's Screen Recording prompt, or the portal's), and only to a workspace that holds the PC.
   - The PC shows that it is being viewed: the system's screen-recording indicator in the menu bar or top bar.
   - Alternative: also ask per workspace, as a grant separate from its file and command access.
2. **Linux source.** Recommended: the daemon serves RFB from the portal. Alternatives:
   - Require wayvnc, krfb or x11vnc installed. That's a setup step for most owners, and none of them is in the
     workstation's default install.
   - Add an RDP client to the browser for GNOME's own server. That means a second client and protocol in the
     Environment.
3. **macOS source.** Recommended: the helper above, so neither a password nor a listener exists. Alternative: relay the
   system's Screen Sharing with a VNC password set for Kinu. That needs no compiler on the Mac, but Kinu holds the
   password and port 5900 stays open while sharing is on.

## Pieces, in order

1. Protocol and relay: the device reports `desktop` in `hello`; `screenOpen`, `screenClose` and the binary data frame;
   the screen hub; the route; the daemon's RFB server. Tested against a fixed screen, through the hub and through the
   vendored client in Chrome. No system's source ships in it, so every PC reports none.
2. Named PC sessions in the daemon, and the strip reading them.
3. Linux portal source in the daemon, and `kinu desktop share`.
4. The macOS helper, and its build and a measured run in the Mac proof.

Each ships in a daemon release, which the hub pushes to every connected PC whose owner left updates on.

## Measured, and not

- Measured on the Linux workstation (GNOME Shell 50.1):
  - gnome-remote-desktop configured for RDP only;
  - GStreamer `pipewiresrc` 1.6.2 and `jpegenc` present;
  - ffmpeg present;
  - x11vnc and wayvnc absent.
- Not measured:
  - The portal path end to end. The workstation has no graphical session running now: its portal calls time out, and
    a screen share on the owner's own desktop needs them present to allow it.
  - Frame rate and input latency over the tunnel.
  - All of macOS: the helper's build, its permissions, and what Screen Sharing's listener binds to. Armada has no Mac;
    the Mac proof measures them on the owner's.
