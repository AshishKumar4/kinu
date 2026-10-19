# A connected PC's desktop and shell

Design for the owner's review, 2026-10-19. Requests 1014-t ("a connected PC's desktop", m134) and 1019-aa ("one
experience across the computer, PCs and the workspace, with desktop support for those that offer", m067, m134, #99).
The wireframe is the gallery's `workspaceshell` frame with `&pc=granted&pcdesktop=ready|setup|permission|update`; its
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
  - **setup**: something on the PC is off. The daemon names it, for example "Turn on Screen Sharing in System Settings ›
    General › Sharing".
  - **permission**: the PC is showing its own prompt, and the screen opens once someone at the PC allows it.
  - **update**: the daemon is older than this feature. `kinu update` brings it.
  - A PC with no screen to share (no graphical session) has no Desktop tab at all.

The device reports which of these applies when it connects, and again whenever it changes (`DEVICE_DESKTOP_STATES`,
`packages/core/src/execution/device-desktop.ts`). The client reads it from the device's roster row (`desktop`).

## How the screen gets here

There is one stream, RFB, the protocol the Environment's desktop client already speaks (`public/kasmvnc`). The browser
opens `/api/workspaces/<workspace>/devices/<device>/desktop` (`desktopClientUrl(at, workspace, device)`). It is gated as
the computer's desktop is: the owner's session plus this workspace's grant on the device. The owner's UserDO relays the
stream over the device tunnel to the daemon, which connects to the PC's screen server on loopback only.

Over the tunnel:
- `screenOpen` is a new method (JSON, as every method is): the hub opens a stream and numbers it, and the daemon answers
  once it reaches the PC's screen server. `screenClose` is a JSON frame from either side.
- The screen's bytes cross as **binary WebSocket messages**, never text: each is a 1-byte kind (data), the stream's
  number as a big-endian u32, then up to 64 KiB of RFB. Both ends of the tunnel are WebSockets that carry binary (the
  UserDO's hibernatable socket, `webSocketMessage(ws, string | ArrayBuffer)`, and Bun's client), and so does the
  browser's socket to the UserDO. The stream number drops bytes a closed stream left in flight.
- RFB paces itself: the client asks for each framebuffer update, so the daemon sends a frame only when the viewer can
  take one, and a slow tunnel slows the frame rate, not memory.
- A screen hub sits beside `DeviceTerminalHub`. It pairs the browser's socket with the daemon's stream, one viewer at
  a time, and relays the bytes unread.

Binary is a protocol change at the two ends' dispatch, and nowhere else. Today the hub decodes every message from a
device as text before it parses it (`user-do.ts`, `webSocketMessage`), and so does the daemon (`index.js`, its socket's `message` listener); each
gains a binary branch for screen data. No existing frame changes, and no daemon or hub of an earlier release ever meets a
binary frame: the hub opens a screen only on a daemon whose `hello` reports one, and only such a daemon sends one.

Where the PC's screen server comes from depends on the system:

- **macOS: the system's own Screen Sharing**, an RFB server on 127.0.0.1:5900. The daemon handles its authentication
  itself, with the VNC password the owner sets for it in System Settings › General › Sharing › Screen Sharing ("VNC
  viewers may control screen with password"). `kinu desktop share` stores that password at 0600 beside `device.json`.
  The browser side of the tunnel needs no authentication and never sees the password. **setup** means Screen Sharing is
  off or no password is set.
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
     system's own consent (Screen Sharing on, or the portal's prompt), and only to a workspace that holds the PC.
   - The PC shows that it is being viewed: the system's screen-sharing indicator in the menu bar or top bar.
   - Alternative: also ask per workspace, as a grant separate from its file and command access.
2. **Linux source.** Recommended: the daemon serves RFB from the portal. Alternatives:
   - Require wayvnc, krfb or x11vnc installed. That's a setup step for most owners, and none of them is in the
     workstation's default install.
   - Add an RDP client to the browser for GNOME's own server. That means a second client and protocol in the
     Environment.
3. **macOS authentication.** Recommended: a VNC password set for Kinu. Rejected: Apple's account-password
   authentication, because the daemon would then hold the owner's login password.

## Pieces, in order

1. Protocol and relay: the device reports `desktop` in `hello`; `screenOpen`, `screenClose` and the binary data frame;
   the screen hub; the route. Tested against a stub daemon that serves a fixed RFB framebuffer.
2. macOS relay in the daemon.
3. Linux portal server in the daemon.
4. Named PC sessions in the daemon, and the strip reading them.

Steps 2 to 4 ship in a daemon release. A PC on an older daemon shows **update** and keeps its one shell.

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
  - All of macOS. Armada has no Mac, and the macOS proof for L111 is waiting on the same question to the owner.
