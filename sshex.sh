#!/bin/sh
if ( tty | grep -q /pt ) ; then
	COLS=`tput cols`
	LINES=`tput lines`
	TTY=`tty`
	stty raw -echo 2>/dev/null
	node /c/tp/sshex/sshex.js --win-alternative-terminal "$TTY" --win-terminal-rows "$LINES" --win-terminal-cols "$COLS" "$@"
	stty sane 2>/dev/null
else
	node /c/tp/sshex/sshex.js "$@"
fi
