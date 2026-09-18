#!/bin/sh
# Docker healthcheck for the postiz container (see docker-compose.override.yml).
# Checks the backend and the orchestrator, and self-heals the occasional stuck
# boot: after RESTART_AFTER failed checks in a row the container is restarted,
# which is what `docker compose restart postiz` does by hand.
#
# The container is restarted by ending its foreground process (`pm2 logs`) so
# that `restart: always` brings it back. `pm2 restart <name>` is not enough:
# the image has no ps/pgrep, so pm2 can't kill the process tree and leaves the
# stuck node process behind (still holding its port).
#
# The exit code is the health status, the output ends up in
# `docker inspect postiz --format '{{json .State.Health.Log}}'`.
RESTART_AFTER="${HEALTHCHECK_RESTART_AFTER:-10}"
STATE=/tmp/healthcheck-fails

failed="$(node -e 'Promise.all(process.argv.slice(1).map((t)=>{const [name,url]=t.split("=");return fetch(url,{signal:AbortSignal.timeout(5000)}).then((r)=>(r.ok?"":name),()=>name)})).then((r)=>console.log(r.filter(Boolean).join(" ")))' \
  backend=http://127.0.0.1:3000/ orchestrator=http://127.0.0.1:3002/health/status)" || failed="healthcheck"

if [ -z "$failed" ]; then
  rm -f "$STATE"
  exit 0
fi

# failures are counted per container start (/tmp survives a restart), so every
# boot gets the full RESTART_AFTER checks
boot="$(stat -c %Y /proc/1)"
last_boot=""
fails=0
[ -f "$STATE" ] && read -r last_boot fails < "$STATE"
[ "$last_boot" = "$boot" ] || fails=0
fails=$((fails + 1))
echo "$boot $fails" > "$STATE"
echo "no answer from: $failed ($fails/$RESTART_AFTER)"

if [ "$fails" -ge "$RESTART_AFTER" ]; then
  echo "restarting the container"
  for proc in /proc/[0-9]*; do
    case "$({ tr '\0' ' ' < "$proc/cmdline"; } 2>/dev/null)" in
      *'/pm2 logs '*) kill "${proc#/proc/}" ;;
    esac
  done
fi
exit 1
