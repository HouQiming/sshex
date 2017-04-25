#!/bin/sh
COLS=`tput cols`
LINES=`tput lines`
stty raw -echo
node sshex.js --win-terminal-rows $LINES --win-terminal-cols $COLS "$@"
stty sane
