export const DESKTOP_PORT = 6080;

const LOG = '/tmp/devbox-desktop.log';

export const DESKTOP_START = `cd /
printf '%s\\n' 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --disable-gpu --disable-dev-shm-usage --disable-component-update"' > /etc/chromium.d/devbox
if ! pgrep -x Xkasmvnc >/dev/null; then
  setsid Xkasmvnc :0 -geometry 1280x800 -depth 24 -interface 0.0.0.0 -websocketPort ${String(DESKTOP_PORT)} \\
    -DisableBasicAuth 1 -sslOnly 0 -SecurityTypes None -AlwaysShared -publicIP 127.0.0.1 >${LOG} 2>&1 </dev/null &
  server=$!
fi
until (exec 3<>/dev/tcp/127.0.0.1/${String(DESKTOP_PORT)}) 2>/dev/null; do
  pgrep -x Xkasmvnc >/dev/null || { [ -n "\${server-}" ] && kill -0 "$server" 2>/dev/null; } || { tail -n 20 ${LOG} >&2; exit 1; }
  sleep 0.05
done
if ! pgrep -x openbox >/dev/null; then
  DISPLAY=:0 setsid openbox >/dev/null 2>&1 </dev/null &
  wm=$!
  until pgrep -x openbox >/dev/null; do kill -0 "$wm" 2>/dev/null || exit 1; sleep 0.01; done
fi`;
