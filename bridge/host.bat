@echo off
rem bridge/host.bat - DB-1: Windows native-messaging hosts must point at an .exe/.bat (spec 3.1).
node "%~dp0host.js" %*
