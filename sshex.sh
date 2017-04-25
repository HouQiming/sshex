#!/bin/sh
COLS=`tput cols`
LINES=`tput lines`
( tty | grep -q /pt ) && stty raw -echo 2>/dev/null
node /c/tp/sshex/sshex.js --win-terminal-rows $LINES --win-terminal-cols $COLS "$@"
( tty | grep -q /pt ) && stty sane 2>/dev/null
