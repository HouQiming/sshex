#!/bin/sh
trap 'stty --file $1 size >&2' WINCH
while true; do
sleep 10 & PID=$!
wait >/dev/null 2>/dev/null
kill $PID >/dev/null 2>/dev/null
done
