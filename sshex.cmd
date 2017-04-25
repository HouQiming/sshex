@echo off
chcp 65001 > NUL
set TERM=cygwin
node c:\tp\sshex\sshex.js %*
