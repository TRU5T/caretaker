#!/bin/sh
# Run the Hub as an unprivileged user. If started as root (the default), make
# sure the data volume belongs to that user, then drop privileges.
# Override the user with CARETAKER_UID / CARETAKER_GID (e.g. 99/100 on Unraid).
set -e

uid="${CARETAKER_UID:-1000}"
gid="${CARETAKER_GID:-1000}"
data="${CARETAKER_DATA:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$data"
  chown -R "$uid:$gid" "$data"
  chmod 700 "$data"
  exec su-exec "$uid:$gid" "$@"
fi

exec "$@"
